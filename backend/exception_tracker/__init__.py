import logging
import math
import re
from datetime import date, datetime, timezone
from io import BytesIO

import azure.functions as func
import pandas as pd

from shared import cosmos_client
from shared.exception_tracker_engine import reconcile
from shared.response_helpers import cors_options, cors_response

_DATE_IN_FILENAME_RE = re.compile(r'(\d{4}-\d{2}-\d{2})')


def _clean_str(v, default: str = '') -> str:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return default
    return str(v).strip()


def _clean_float(v, default: float = 0.0) -> float:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return default
    try:
        s = str(v).replace('$', '').replace(',', '').strip()
        return float(s)
    except (ValueError, TypeError):
        return default


def _row_to_instance(row: dict) -> dict | None:
    instance_id = _clean_str(row.get('Instance Id'))
    if not instance_id:
        return None
    return {
        'instanceId': instance_id,
        'instanceName': _clean_str(row.get('Instance Name')) or instance_id,
        'accountName': _clean_str(row.get('Account Name')),
        'apiName': _clean_str(row.get('API Name')),
        'product': _clean_str(row.get('Product')),
        'tenancy': _clean_str(row.get('Tenancy')),
        'zoneName': _clean_str(row.get('Zone Name')),
        'attachedEbs': _clean_str(row.get('Attached EBS')),
        'projectedCostForMonth': _clean_float(row.get('Projected Cost For Month')),
        'launchedBy': _clean_str(row.get('Launched By')),
        'ownerEmail': _clean_str(row.get('Owner Email')),
    }


def _handle_import(req: func.HttpRequest, customer_id: str) -> func.HttpResponse:
    uploaded = req.files.get('file')
    if uploaded is None:
        return cors_response({'error': 'multipart field "file" is required'}, 400)

    filename = uploaded.filename or 'aws_instances.csv'
    file_bytes = uploaded.read()

    def field(name: str) -> str:
        return (req.params.get(name) or req.form.get(name, '')).strip()

    snapshot_date_str = field('snapshotDate')
    if not snapshot_date_str:
        m = _DATE_IN_FILENAME_RE.search(filename)
        snapshot_date_str = m.group(1) if m else date.today().isoformat()

    try:
        date.fromisoformat(snapshot_date_str)
    except ValueError:
        return cors_response({'error': 'snapshotDate must be YYYY-MM-DD'}, 400)

    try:
        df = pd.read_csv(BytesIO(file_bytes))
    except Exception as exc:
        return cors_response({'error': f'Could not parse CSV: {exc}'}, 422)

    if df.empty:
        return cors_response({'error': 'CSV contains no data rows'}, 422)

    rows = df.where(pd.notna(df), None).to_dict(orient='records')
    instances = [inst for inst in (_row_to_instance(r) for r in rows) if inst is not None]

    cosmos_client.delete_inventory_instances_for_snapshot(customer_id, snapshot_date_str)
    cosmos_client.upsert_inventory_instances_bulk(customer_id, snapshot_date_str, instances)
    cosmos_client.upsert_inventory_snapshot(
        customer_id, snapshot_date_str, filename, len(instances),
        imported_at=datetime.now(timezone.utc),
    )

    return cors_response({
        'success': True,
        'snapshotDate': snapshot_date_str,
        'instanceCount': len(instances),
    })


def _handle_reconcile(req: func.HttpRequest, customer_id: str) -> func.HttpResponse:
    snapshot_date = (req.params.get('snapshotDate') or '').strip()
    if not snapshot_date:
        snapshots = cosmos_client.list_inventory_snapshots(customer_id)
        if not snapshots:
            return cors_response({'error': 'No inventory snapshots imported for this customer yet'}, 404)
        snapshot_date = snapshots[0].snapshotDate

    report = reconcile(customer_id, snapshot_date)
    return cors_response(report)


def _handle_snapshots(customer_id: str) -> func.HttpResponse:
    snapshots = cosmos_client.list_inventory_snapshots(customer_id)
    return cors_response([s.to_dict() for s in snapshots])


def _handle_narrative_patch(req: func.HttpRequest, customer_id: str) -> func.HttpResponse:
    """Saves the (possibly edited) exception-progress narrative into the current
    'generated' report for that month/year, alongside other report narrative sections."""
    try:
        body = req.get_json()
    except ValueError:
        return cors_response({'error': 'Request body must be valid JSON'}, 400)

    month = body.get('month')
    year = body.get('year')
    narrative = body.get('narrative')
    if not isinstance(month, int) or not isinstance(year, int) or narrative is None:
        return cors_response({'error': 'month, year (integers) and narrative are required'}, 400)

    all_reports = cosmos_client.list_reports(customer_id, year=year)
    report = next(
        (r for r in all_reports if r.source == 'generated' and r.month == month and r.year == year),
        None,
    )
    if report is None:
        return cors_response(
            {'error': f'No generated report found for {month}/{year}. Generate a report for this period first.'},
            404,
        )

    ext = report.extractedData or {}
    ext['exceptionProgressNarrative'] = narrative
    report.extractedData = ext
    cosmos_client.update_report(report)

    return cors_response({'success': True})


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('exception_tracker triggered: %s %s', req.method, req.url)
    customer_id = (req.route_params.get('customerId') or '').strip()
    action = (req.route_params.get('action') or '').strip()

    if req.method == 'OPTIONS':
        return cors_options()
    if not customer_id:
        return cors_response({'error': 'customerId is required'}, 400)

    try:
        method = req.method.upper()

        if method == 'POST' and action == 'import-inventory':
            return _handle_import(req, customer_id)
        if method == 'GET' and action == 'reconcile':
            return _handle_reconcile(req, customer_id)
        if method == 'GET' and action == 'snapshots':
            return _handle_snapshots(customer_id)
        if method == 'PATCH' and action == 'narrative':
            return _handle_narrative_patch(req, customer_id)

        return cors_response(
            {'error': f'Unrecognised route: {method} /exception-tracker/{customer_id}/{action}'}, 404,
        )
    except Exception as exc:
        logging.exception('exception_tracker unhandled error')
        return cors_response({'error': str(exc)}, 500)
