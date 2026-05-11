import json
import logging
from io import BytesIO

import azure.functions as func
import pandas as pd

from shared import blob_client, cosmos_client
from shared.trend_engine import aggregate_csv

VALID_SERVICE_TYPES = {'EC2', 'EBS', 'RDS', 'S3', 'ElastiCache', 'Redshift', 'OpenSearch', 'DynamoDB', 'Consolidated'}


def _json(body, status: int = 200) -> func.HttpResponse:
    return func.HttpResponse(json.dumps(body), status_code=status, mimetype='application/json')


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('patch_upload triggered')
    try:
        return _handle(req)
    except Exception as exc:
        logging.exception('patch_upload unhandled error')
        return _json({'error': str(exc)}, 500)


def _handle(req: func.HttpRequest) -> func.HttpResponse:
    upload_id = req.route_params.get('uploadId', '').strip()
    if not upload_id:
        return _json({'error': 'uploadId route parameter is required'}, 400)

    try:
        body = req.get_json()
    except ValueError:
        return _json({'error': 'Request body must be valid JSON'}, 400)

    customer_id = (body.get('customerId') or '').strip()
    new_service_type = (body.get('serviceType') or '').strip()

    if not customer_id:
        return _json({'error': 'customerId is required'}, 400)
    if not new_service_type:
        return _json({'error': 'serviceType is required'}, 400)
    if new_service_type not in VALID_SERVICE_TYPES:
        return _json({'error': f'serviceType must be one of: {", ".join(sorted(VALID_SERVICE_TYPES))}'}, 400)

    upload = cosmos_client.get_upload(upload_id, customer_id)
    if upload is None:
        return _json({'error': f'Upload {upload_id!r} not found'}, 404)

    old_service_type = upload.serviceType
    if old_service_type == new_service_type:
        return _json(upload.to_dict())

    # ── Re-aggregate the stored blob with the new service type ─────────────────
    file_bytes = blob_client.download_file(upload.blobPath)
    df = pd.read_csv(BytesIO(file_bytes))
    agg = aggregate_csv(df, new_service_type)

    # ── Update every linked TrendData record ───────────────────────────────────
    # A TrendData record is "linked" if it shares customer/month/year/snapshotDate
    # and has the OLD service type (the one we're correcting away from).
    existing_trends = cosmos_client.list_trends(customer_id, year=upload.year, service_type=old_service_type)
    linked = [
        t for t in existing_trends
        if t.month == upload.month and t.snapshotDate == upload.snapshotDate
    ]
    for trend in linked:
        trend.serviceType = new_service_type
        trend.savingsTotal = agg['savingsTotal']
        cosmos_client.upsert_trend(trend)

    # ── Update the Upload record ───────────────────────────────────────────────
    upload.serviceType = new_service_type
    upload.savingsTotal = agg['savingsTotal']
    upload.isRelabeled = True
    cosmos_client.update_upload(upload)

    logging.info(
        'Relabeled upload %s: %s → %s (linked trends updated: %d)',
        upload_id, old_service_type, new_service_type, len(linked),
    )
    return _json(upload.to_dict())
