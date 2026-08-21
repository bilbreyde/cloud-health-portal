import logging
import re
from datetime import datetime, timezone
from typing import Optional

import azure.functions as func

from shared import cosmos_client
from shared.response_helpers import cors_options, cors_response

_MONTH_RE = re.compile(r'^\d{4}-\d{2}$')
_SHEET_RE = re.compile(r'^Sheet:\s*(.+?)\s*$', re.IGNORECASE)

# Sheet name (lowercased) -> SavingsCoverage field. Sheets present in the export
# that aren't in this map (e.g. "EC2 Unknown Coverage") are parsed but ignored.
_SHEET_FIELD_MAP = {
    'ec2 sp coverage': 'ec2SpCoveragePct',
    'ec2 ri coverage': 'ec2RiCoveragePct',
    'ec2 spot coverage': 'ec2SpotCoveragePct',
}


def _parse_savings_csv(file_bytes: bytes) -> dict:
    """Parse the CloudHealth Savings export into {month: {field: pct}}.

    Layout is a sequence of sheet blocks, each:
        Sheet: <name>
        ,<YYYY-MM>,<YYYY-MM>,...
        Total,<pct>,<pct>,...
        <blank line>

    Unlike CostHistory, there's no per-service breakdown here — each sheet has
    exactly one data row ("Total") giving one coverage percentage per month.
    """
    content = file_bytes.decode('utf-8-sig')
    lines = [line.rstrip('\r') for line in content.split('\n')]

    by_month: dict[str, dict] = {}
    current_field: Optional[str] = None
    month_cols: list[str] = []

    for line in lines:
        sheet_match = _SHEET_RE.match(line.strip())
        if sheet_match:
            sheet_name = sheet_match.group(1).strip().lower()
            current_field = _SHEET_FIELD_MAP.get(sheet_name)
            month_cols = []
            continue

        if current_field is None:
            continue

        cells = [c.strip() for c in line.split(',')]

        if not month_cols:
            if any(_MONTH_RE.match(c) for c in cells):
                month_cols = cells
            continue

        if cells and cells[0].strip().lower() == 'total':
            for col_idx, month in enumerate(month_cols):
                if not _MONTH_RE.match(month) or col_idx >= len(cells):
                    continue
                raw = cells[col_idx].strip()
                if not raw:
                    continue
                try:
                    pct = float(raw)
                except ValueError:
                    continue
                by_month.setdefault(month, {})[current_field] = pct
            current_field = None
            month_cols = []

    return by_month


def _to_dict(rec) -> dict:
    return {
        'month': rec.month,
        'ec2SpCoveragePct': rec.ec2SpCoveragePct,
        'ec2RiCoveragePct': rec.ec2RiCoveragePct,
        'ec2SpotCoveragePct': rec.ec2SpotCoveragePct,
        'importedAt': rec.importedAt.isoformat(),
    }


def _handle_import(req: func.HttpRequest, customer_id: str) -> func.HttpResponse:
    customer = cosmos_client.get_customer(customer_id)
    if customer is None:
        return cors_response({'error': f'Customer {customer_id!r} not found'}, 404)

    uploaded = req.files.get('file')
    if uploaded is None:
        return cors_response({'error': 'multipart field "file" is required'}, 400)

    filename = uploaded.filename or 'Savings.csv'
    file_bytes = uploaded.read()

    try:
        by_month = _parse_savings_csv(file_bytes)
    except Exception as exc:
        return cors_response({'error': f'Could not parse Savings CSV: {exc}'}, 422)

    if not by_month:
        return cors_response(
            {'error': 'No coverage data found in CSV (expected "EC2 SP/RI/Spot Coverage" sheets)'}, 422,
        )

    now = datetime.now(timezone.utc)
    for month, fields in by_month.items():
        cosmos_client.upsert_savings_coverage(
            customer_id=customer_id,
            month=month,
            ec2_sp_coverage_pct=fields.get('ec2SpCoveragePct'),
            ec2_ri_coverage_pct=fields.get('ec2RiCoveragePct'),
            ec2_spot_coverage_pct=fields.get('ec2SpotCoveragePct'),
            imported_at=now,
        )

    return cors_response({
        'success': True,
        'monthsImported': len(by_month),
        'fileName': filename,
        'importedAt': now.isoformat(),
    })


def _handle_get(req: func.HttpRequest, customer_id: str) -> func.HttpResponse:
    customer = cosmos_client.get_customer(customer_id)
    if customer is None:
        return cors_response({'error': f'Customer {customer_id!r} not found'}, 404)

    requested_month = (req.params.get('month') or '').strip()
    all_records = cosmos_client.list_savings_coverage(customer_id)
    if not all_records:
        return cors_response({'error': 'No savings coverage data imported yet'}, 404)

    if requested_month:
        record = next((r for r in all_records if r.month == requested_month), None)
        is_fallback = record is None
        record = record or all_records[0]
    else:
        record = all_records[0]
        is_fallback = False

    payload = _to_dict(record)
    payload['requestedMonth'] = requested_month or record.month
    payload['isFallback'] = is_fallback
    return cors_response(payload)


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('savings_coverage triggered: %s %s', req.method, req.url)
    customer_id = (req.route_params.get('customerId') or '').strip()
    action = (req.route_params.get('action') or '').strip()

    if req.method == 'OPTIONS':
        return cors_options()
    if not customer_id:
        return cors_response({'error': 'customerId is required'}, 400)

    try:
        method = req.method.upper()

        if method == 'POST' and action == 'import':
            return _handle_import(req, customer_id)
        if method == 'GET' and not action:
            return _handle_get(req, customer_id)

        return cors_response(
            {'error': f'Unrecognised route: {method} /savings-coverage/{customer_id}/{action}'}, 404,
        )

    except Exception as exc:
        logging.exception('savings_coverage unhandled error')
        return cors_response({'error': str(exc)}, 500)
