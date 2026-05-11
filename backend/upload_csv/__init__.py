import json
import logging
import uuid
from datetime import date, datetime, timezone
from io import BytesIO

import azure.functions as func
import pandas as pd

from shared import blob_client, cosmos_client
from shared.models import TrendData, Upload
from shared.trend_engine import aggregate_csv, detect_service_type, normalize_filename_to_key


def _json(body: dict, status: int = 200) -> func.HttpResponse:
    return func.HttpResponse(json.dumps(body), status_code=status, mimetype='application/json')


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('upload_csv triggered')
    try:
        return _handle(req)
    except Exception as exc:
        logging.exception('upload_csv unhandled error')
        return _json({'error': str(exc)}, 500)


def _handle(req: func.HttpRequest) -> func.HttpResponse:
    # ── Form fields (multipart) ────────────────────────────────────────────────
    def field(name: str) -> str:
        return (req.params.get(name) or req.form.get(name, '')).strip()

    customer_id = field('customerId')
    month_str = field('month')
    year_str = field('year')
    service_type_hint = field('serviceType')
    snapshot_date_str = field('snapshotDate') or date.today().isoformat()

    if not customer_id:
        return _json({'error': 'customerId is required'}, 400)
    if not month_str or not year_str:
        return _json({'error': 'month and year are required'}, 400)

    try:
        month = int(month_str)
        year = int(year_str)
    except ValueError:
        return _json({'error': 'month and year must be integers'}, 400)

    if not 1 <= month <= 12:
        return _json({'error': 'month must be 1–12'}, 400)
    if year < 2026:
        return _json({'error': 'year must be 2026 or later'}, 400)

    try:
        date.fromisoformat(snapshot_date_str)
    except ValueError:
        return _json({'error': 'snapshotDate must be YYYY-MM-DD'}, 400)

    # ── File ───────────────────────────────────────────────────────────────────
    uploaded = req.files.get('file')
    if uploaded is None:
        return _json({'error': 'multipart field "file" is required'}, 400)

    filename = uploaded.filename
    file_bytes = uploaded.read()

    # ── Customer validation ────────────────────────────────────────────────────
    customer = cosmos_client.get_customer(customer_id)
    if customer is None:
        return _json({'error': f'Customer {customer_id!r} not found'}, 404)

    # ── Parse CSV ──────────────────────────────────────────────────────────────
    try:
        df = pd.read_csv(BytesIO(file_bytes))
    except Exception as exc:
        return _json({'error': f'Could not parse CSV: {exc}'}, 422)

    if df.empty:
        return _json({'error': 'CSV contains no data rows'}, 422)

    # ── Detect service & aggregate ─────────────────────────────────────────────
    service_type = service_type_hint or detect_service_type(filename, list(df.columns))
    report_key = normalize_filename_to_key(filename)
    agg = aggregate_csv(df, service_type)

    # ── Determine snapshot number ──────────────────────────────────────────────
    # Count existing TrendData records for this customer/year/month/service.
    existing = cosmos_client.list_trends(customer_id, year=year, service_type=service_type)
    snapshot_number = sum(1 for t in existing if t.month == month) + 1

    # ── Blob upload ────────────────────────────────────────────────────────────
    blob_path = blob_client.upload_csv(customer_id, month, year, service_type, file_bytes, filename)

    # ── Cosmos: Upload record ──────────────────────────────────────────────────
    upload_id = str(uuid.uuid4())
    upload = Upload(
        id=upload_id,
        customerId=customer_id,
        month=month,
        year=year,
        serviceType=service_type,
        fileName=filename,
        blobPath=blob_path,
        uploadedAt=datetime.now(timezone.utc),
        status='processed',
    )
    cosmos_client.create_upload(upload)

    # ── Cosmos: TrendData record ───────────────────────────────────────────────
    trend = TrendData(
        id=str(uuid.uuid4()),
        customerId=customer_id,
        month=month,
        year=year,
        serviceType=service_type,
        reportKey=report_key,
        savingsTotal=agg['savingsTotal'],
        rowCount=agg['rowCount'],
        momDelta=0.0,
        direction='Flat',
        snapshotDate=snapshot_date_str,
        snapshotNumber=snapshot_number,
    )
    cosmos_client.upsert_trend(trend)

    return _json({
        'success': True,
        'uploadId': upload_id,
        'serviceType': service_type,
        'savingsTotal': agg['savingsTotal'],
        'rowCount': agg['rowCount'],
        'snapshotDate': snapshot_date_str,
        'snapshotNumber': snapshot_number,
    })
