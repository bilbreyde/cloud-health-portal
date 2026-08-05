import logging
from io import BytesIO

import azure.functions as func
import pandas as pd

from shared import blob_client, cosmos_client
from shared.response_helpers import cors_no_content, cors_options, cors_response
from shared.trend_engine import aggregate_csv

VALID_SERVICE_TYPES = {'EC2', 'EBS', 'RDS', 'S3', 'ElastiCache', 'Redshift', 'OpenSearch', 'DynamoDB', 'Consolidated'}


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('patch_upload triggered: %s', req.method)
    if req.method == 'OPTIONS':
        return cors_options()
    try:
        if req.method == 'DELETE':
            return _handle_delete(req)
        return _handle(req)
    except Exception as exc:
        logging.exception('patch_upload unhandled error')
        return cors_response({'error': str(exc)}, 500)


def _handle_delete(req: func.HttpRequest) -> func.HttpResponse:
    upload_id = req.route_params.get('uploadId', '').strip()
    if not upload_id:
        return cors_response({'error': 'uploadId route parameter is required'}, 400)

    customer_id = (req.params.get('customerId') or '').strip()
    if not customer_id:
        return cors_response({'error': 'customerId query parameter is required'}, 400)

    upload = cosmos_client.get_upload(upload_id, customer_id)
    if upload is None:
        return cors_response({'error': f'Upload {upload_id!r} not found'}, 404)

    deleted_trends = cosmos_client.delete_trends_for_upload(
        customer_id, upload.month, upload.year, upload.serviceType, upload.snapshotDate,
    )

    try:
        blob_client.delete_blob(upload.blobPath)
    except Exception as exc:
        logging.warning('Blob delete failed for upload %s (non-fatal): %s', upload_id, exc)

    cosmos_client.delete_upload(upload_id, customer_id)

    logging.info(
        'Deleted upload %s (%s) — %d linked TrendData record(s) removed',
        upload_id, upload.fileName, deleted_trends,
    )
    return cors_no_content()


def _handle(req: func.HttpRequest) -> func.HttpResponse:
    upload_id = req.route_params.get('uploadId', '').strip()
    if not upload_id:
        return cors_response({'error': 'uploadId route parameter is required'}, 400)

    try:
        body = req.get_json()
    except ValueError:
        return cors_response({'error': 'Request body must be valid JSON'}, 400)

    customer_id = (body.get('customerId') or '').strip()
    new_service_type = (body.get('serviceType') or '').strip()

    if not customer_id:
        return cors_response({'error': 'customerId is required'}, 400)
    if not new_service_type:
        return cors_response({'error': 'serviceType is required'}, 400)
    if new_service_type not in VALID_SERVICE_TYPES:
        return cors_response({'error': f'serviceType must be one of: {", ".join(sorted(VALID_SERVICE_TYPES))}'}, 400)

    upload = cosmos_client.get_upload(upload_id, customer_id)
    if upload is None:
        return cors_response({'error': f'Upload {upload_id!r} not found'}, 404)

    old_service_type = upload.serviceType
    if old_service_type == new_service_type:
        return cors_response(upload.to_dict())

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
    return cors_response(upload.to_dict())
