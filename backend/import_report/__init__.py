import json
import logging
import re
import uuid
from datetime import datetime, timezone
from io import BytesIO

import azure.functions as func

from shared import blob_client, cosmos_client
from shared.models import Report

_DOLLAR_RE = re.compile(r'\$?\s*([\d,]+(?:\.\d{1,2})?)')
_SECTION_RE = re.compile(r'^(?:Section\s+)?(\d+\.\d+)\b', re.IGNORECASE)
_SERVICE_TYPES = {'EC2', 'EBS', 'RDS', 'S3', 'ElastiCache', 'Redshift',
                  'OpenSearch', 'DynamoDB', 'Consolidated'}


def _extract_dollar(text: str) -> float:
    m = _DOLLAR_RE.search(text)
    if not m:
        return 0.0
    try:
        return float(m.group(1).replace(',', ''))
    except (ValueError, IndexError):
        return 0.0


def _match_service(text: str) -> str | None:
    for svc in _SERVICE_TYPES:
        if svc.lower() in text.lower():
            return svc
    return None


def _parse_docx(file_bytes: bytes) -> dict:
    from docx import Document  # import here so non-docx paths skip the dependency

    extracted: dict = {
        'monthlySavings': {},
        'topMoversUp': [],
        'topMoversDown': [],
        'realizedSavings': 0.0,
        'exceptionFloor': 0.0,
        'nextSteps': [],
    }

    doc = Document(BytesIO(file_bytes))

    # ── Tables: find savings signal table ─────────────────────────────────────
    for table in doc.tables:
        if not table.rows:
            continue
        headers = [c.text.strip() for c in table.rows[0].cells]
        header_text = ' '.join(headers).lower()

        # Detect service-type tables by header keywords
        if not ('service' in header_text or 'saving' in header_text or
                any(s.lower() in header_text for s in _SERVICE_TYPES)):
            continue

        for row in table.rows[1:]:
            cells = [c.text.strip() for c in row.cells]
            if not cells or not cells[0]:
                continue
            svc = _match_service(cells[0])
            if svc:
                # Last non-empty cell with a dollar-like value wins
                for cell_val in reversed(cells[1:]):
                    amt = _extract_dollar(cell_val)
                    if amt > 0:
                        extracted['monthlySavings'][svc] = amt
                        break

    # ── Paragraphs ─────────────────────────────────────────────────────────────
    in_next_steps = False
    in_top_movers_up = False
    in_top_movers_down = False

    for para in doc.paragraphs:
        text = para.text.strip()
        if not text:
            continue
        lower = text.lower()

        # Detect section transitions
        sec_m = _SECTION_RE.match(text)
        if sec_m:
            sec = sec_m.group(1)
            in_next_steps = sec.startswith('9')
            in_top_movers_up = sec == '4.1'
            in_top_movers_down = sec == '4.2'
            continue

        # Keyword-based section detection (for docs without numeric headers)
        if re.search(r'next\s+steps?|recommended\s+actions?', lower):
            in_next_steps = True
            in_top_movers_up = in_top_movers_down = False
            continue
        if re.search(r'top\s+movers?\s+(up|increase|rais)', lower):
            in_top_movers_up = True
            in_top_movers_down = in_next_steps = False
            continue
        if re.search(r'top\s+movers?\s+(down|decrease|reduc)', lower):
            in_top_movers_down = True
            in_top_movers_up = in_next_steps = False
            continue

        # Next steps collection
        if in_next_steps:
            # Stop at a new top-level section
            if re.match(r'^(?:Section\s+)?\d+\.?\s+[A-Z]', text):
                in_next_steps = False
            else:
                step = re.sub(r'^[-•*•●◦\d]+[.)]\s*', '', text).strip()
                if step and len(step) > 8 and step not in extracted['nextSteps']:
                    extracted['nextSteps'].append(step)
            continue

        # Top movers up — look for lines like "EC2: +$12,345" or "EC2 increased $..."
        if in_top_movers_up:
            svc = _match_service(text)
            amt = _extract_dollar(text)
            if svc and amt > 0 and not any(m['serviceType'] == svc for m in extracted['topMoversUp']):
                extracted['topMoversUp'].append({'serviceType': svc, 'amount': amt})
            continue

        # Top movers down
        if in_top_movers_down:
            svc = _match_service(text)
            amt = _extract_dollar(text)
            if svc and amt > 0 and not any(m['serviceType'] == svc for m in extracted['topMoversDown']):
                extracted['topMoversDown'].append({'serviceType': svc, 'amount': amt})
            continue

        # Inline keyword extractions (anywhere in doc)
        if re.search(r'realized\s+saving', lower):
            amt = _extract_dollar(text)
            if amt > 0:
                extracted['realizedSavings'] = amt

        if re.search(r'exception\s+floor|exception\s+total', lower):
            amt = _extract_dollar(text)
            if amt > 0:
                extracted['exceptionFloor'] = amt

    # Cap lists
    extracted['nextSteps'] = extracted['nextSteps'][:20]
    extracted['topMoversUp'] = extracted['topMoversUp'][:5]
    extracted['topMoversDown'] = extracted['topMoversDown'][:5]
    return extracted


def _json(body, status: int = 200) -> func.HttpResponse:
    return func.HttpResponse(json.dumps(body), status_code=status, mimetype='application/json')


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('import_report triggered')
    customer_id = (req.route_params.get('customerId') or '').strip()
    if not customer_id:
        return _json({'error': 'customerId is required'}, 400)

    try:
        return _handle(req, customer_id)
    except Exception as exc:
        logging.exception('import_report unhandled error')
        return _json({'error': str(exc)}, 500)


def _handle(req: func.HttpRequest, customer_id: str) -> func.HttpResponse:
    # ── Validate customer ──────────────────────────────────────────────────────
    customer = cosmos_client.get_customer(customer_id)
    if customer is None:
        return _json({'error': f'Customer {customer_id!r} not found'}, 404)

    # ── Form fields ────────────────────────────────────────────────────────────
    def field(name: str) -> str:
        return (req.params.get(name) or req.form.get(name, '')).strip()

    month_str = field('month')
    year_str = field('year')
    report_date = field('reportDate') or datetime.now(timezone.utc).date().isoformat()

    if not month_str or not year_str:
        return _json({'error': 'month and year are required'}, 400)
    try:
        month = int(month_str)
        year = int(year_str)
    except ValueError:
        return _json({'error': 'month and year must be integers'}, 400)
    if not 1 <= month <= 12:
        return _json({'error': 'month must be 1–12'}, 400)

    # ── File ───────────────────────────────────────────────────────────────────
    uploaded = req.files.get('file')
    if uploaded is None:
        return _json({'error': 'multipart field "file" is required'}, 400)

    filename = uploaded.filename or 'report.docx'
    if not filename.lower().endswith('.docx'):
        return _json({'error': 'Only .docx files are supported'}, 400)

    file_bytes = uploaded.read()

    # ── Parse docx ─────────────────────────────────────────────────────────────
    try:
        extracted_data = _parse_docx(file_bytes)
    except Exception as exc:
        logging.warning('docx parse error (storing empty extractedData): %s', exc)
        extracted_data = {
            'monthlySavings': {}, 'topMoversUp': [], 'topMoversDown': [],
            'realizedSavings': 0.0, 'exceptionFloor': 0.0, 'nextSteps': [],
        }

    # ── Upload docx to blob ────────────────────────────────────────────────────
    blob_path = blob_client.upload_docx(customer_id, month, year, file_bytes, filename)

    # ── Save Report record ─────────────────────────────────────────────────────
    report_id = str(uuid.uuid4())
    generated_at = datetime.now(timezone.utc)
    report = Report(
        id=report_id,
        customerId=customer_id,
        month=month,
        year=year,
        status='imported',
        blobPath=blob_path,
        generatedAt=generated_at,
        joelNotes=None,
        narrativeDraft=None,
        source='manual_import',
        extractedData=extracted_data,
    )
    cosmos_client.create_report(report)

    logging.info(
        'Imported report %s for %s/%d/%d — monthlySavings keys: %s, nextSteps: %d',
        report_id, customer_id, month, year,
        list(extracted_data['monthlySavings'].keys()),
        len(extracted_data['nextSteps']),
    )

    return _json({
        'success': True,
        'reportId': report_id,
        'extractedData': extracted_data,
    })
