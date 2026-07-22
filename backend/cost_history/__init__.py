import logging
import re
from datetime import datetime, timezone
from io import StringIO
from typing import Optional

import azure.functions as func
import pandas as pd

from shared import cosmos_client
from shared.response_helpers import cors_options, cors_response

_MONTH_RE = re.compile(r'^\d{4}-\d{2}$')
_SECTION_RE = re.compile(r'^(direct|indirect)\s+charges\s*\(\s*\d+\s*\)\s*$', re.IGNORECASE)


def _parse_amount(raw: str) -> Optional[float]:
    """Parse a CSV cell into a float. Returns None if the cell has no data."""
    s = (raw or '').strip()
    if not s:
        return None
    neg = False
    if s.startswith('(') and s.endswith(')'):
        neg = True
        s = s[1:-1]
    s = s.replace('$', '').replace(',', '').strip()
    if not s:
        return None
    try:
        value = float(s)
    except ValueError:
        return None
    return -value if neg else value


def _parse_cost_history_csv(file_bytes: bytes) -> dict:
    """Parse the CloudHealth-style CostHistory CSV into month columns + service rows.

    Layout: line 0 is a "Sheet: Cost ($)" title line (a single field, no commas),
    line 1 is blank, line 2 holds the real column headers (Subtotal, Service Items,
    <YYYY-MM>..., Total), followed by "Direct Charges (n)" / "Indirect Charges (n)"
    section-header rows that switch the current charge type for the service rows
    beneath them.

    The title line has far fewer fields than every row after it, so handing the
    whole file to pandas with header=None makes the C parser lock in the title
    line's field count and raise a ParserError the moment it reaches the real
    header row. Skip straight to the header line as plain text first, then let
    pandas parse only the well-formed remainder.
    """
    content = file_bytes.decode('utf-8-sig')
    lines = content.split('\n')

    header_line_idx = next(
        (i for i, line in enumerate(lines) if line.strip().lower().startswith('subtotal,')),
        None,
    )
    if header_line_idx is None:
        raise ValueError('Could not find header row (expected a line starting with "Subtotal,")')

    csv_content = '\n'.join(lines[header_line_idx:])
    data = pd.read_csv(StringIO(csv_content), dtype=str, keep_default_na=False)

    col_names = [str(c).strip() for c in data.columns]
    data.columns = col_names

    lower_names = {c.lower(): c for c in col_names}
    subtotal_col = lower_names.get('subtotal', col_names[0] if col_names else None)
    service_col = lower_names.get('service items', col_names[1] if len(col_names) > 1 else None)
    month_cols = [c for c in col_names if _MONTH_RE.match(c)]

    if service_col is None or not month_cols:
        raise ValueError('CSV does not match the expected CostHistory format (missing Service Items / month columns)')

    records: list[dict] = []
    services_seen: set = set()
    current_charge_type: Optional[str] = None

    for _, row in data.iterrows():
        service_label = (row.get(service_col) or '').strip()
        subtotal_label = (row.get(subtotal_col) or '').strip() if subtotal_col else ''

        section_match = _SECTION_RE.match(subtotal_label) or _SECTION_RE.match(service_label)
        if section_match:
            current_charge_type = section_match.group(1).lower()
            continue

        service_name = service_label or subtotal_label
        if not service_name or current_charge_type is None:
            continue

        services_seen.add(service_name)
        for month in month_cols:
            amount = _parse_amount(row.get(month))
            if amount is None:
                continue
            records.append({
                'month': month,
                'service': service_name,
                'amount': amount,
                'chargeType': current_charge_type,
            })

    return {
        'monthColumns': month_cols,
        'records': records,
        'servicesSeen': services_seen,
    }


def _handle_import(req: func.HttpRequest, customer_id: str) -> func.HttpResponse:
    customer = cosmos_client.get_customer(customer_id)
    if customer is None:
        return cors_response({'error': f'Customer {customer_id!r} not found'}, 404)

    uploaded = req.files.get('file')
    if uploaded is None:
        return cors_response({'error': 'multipart field "file" is required'}, 400)

    filename = uploaded.filename or 'CostHistory.csv'
    file_bytes = uploaded.read()

    try:
        parsed = _parse_cost_history_csv(file_bytes)
    except Exception as exc:
        return cors_response({'error': f'Could not parse CostHistory CSV: {exc}'}, 422)

    if not parsed['records']:
        return cors_response({'error': 'No cost rows found in CSV'}, 422)

    now = datetime.now(timezone.utc)
    for rec in parsed['records']:
        cosmos_client.upsert_cost_history(
            customer_id=customer_id,
            month=rec['month'],
            service=rec['service'],
            amount=rec['amount'],
            charge_type=rec['chargeType'],
            imported_at=now,
            source_file=filename,
        )

    return cors_response({
        'success': True,
        'monthsImported': len(parsed['monthColumns']),
        'servicesImported': len(parsed['servicesSeen']),
        'totalRows': len(parsed['records']),
        'importedAt': now.isoformat(),
    })


def _handle_get(req: func.HttpRequest, customer_id: str) -> func.HttpResponse:
    customer = cosmos_client.get_customer(customer_id)
    if customer is None:
        return cors_response({'error': f'Customer {customer_id!r} not found'}, 404)

    start_month = (req.params.get('startMonth') or '0000-00').strip()
    end_month = (req.params.get('endMonth') or '9999-99').strip()

    all_records = cosmos_client.get_cost_history(customer_id, start_month, end_month)
    months = sorted({r.month for r in all_records})

    # No cost history imported yet is a valid, empty state — not an error — so the
    # dashboard/upload pages can render their "not imported yet" UI without treating
    # a routine background fetch as a failed request.
    summary = cosmos_client.get_cost_history_summary(customer_id, months)
    return cors_response(summary)


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('cost_history triggered: %s %s', req.method, req.url)
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

        return cors_response({'error': f'Unrecognised route: {method} /cost-history/{customer_id}/{action}'}, 404)

    except Exception as exc:
        logging.exception('cost_history unhandled error')
        return cors_response({'error': str(exc)}, 500)
