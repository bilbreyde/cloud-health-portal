import logging

import azure.functions as func

from shared import blob_client, cosmos_client
from shared.response_helpers import CORS_HEADERS, cors_options, cors_response


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('reports triggered: %s %s', req.method, req.url)

    customer_id = req.route_params.get('customerId', '').strip()
    if not customer_id:
        return cors_response({'error': 'customerId route parameter is required'}, 400)

    p1 = req.route_params.get('p1', '').strip()
    p2 = req.route_params.get('p2', '').strip()
    method = req.method.upper()

    if method == 'OPTIONS':
        return cors_options()

    # GET /api/reports/{customerId}
    if method == 'GET' and not p1:
        reports = cosmos_client.list_reports(customer_id)
        return cors_response([r.to_dict() for r in reports if r.source != 'dashboard_narrative'])

    # GET /api/reports/{customerId}/{reportId}/download
    if method == 'GET' and p2 == 'download':
        return _handle_download(customer_id, report_id=p1)

    # DELETE /api/reports/{customerId}/drafts/empty
    if method == 'DELETE' and p1 == 'drafts' and p2 == 'empty':
        return _handle_cleanup(customer_id)

    return cors_response({'error': 'Not found'}, 404)


def _handle_download(customer_id: str, report_id: str) -> func.HttpResponse:
    if not report_id:
        return cors_response({'error': 'reportId is required'}, 400)

    report = cosmos_client.get_report(report_id, customer_id)
    if report is None:
        return cors_response({'error': f'Report {report_id!r} not found'}, 404)
    if not report.blobPath:
        return cors_response({'error': 'No file attached to this report'}, 404)

    try:
        file_bytes = blob_client.download_file(report.blobPath)
    except Exception as exc:
        logging.error('Download failed for %s: %s', report.blobPath, exc)
        return cors_response({'error': f'File download failed: {exc}'}, 500)

    filename = f'Cloud_Report_{report.month:02d}_{report.year}.docx'
    return func.HttpResponse(
        body=file_bytes,
        status_code=200,
        mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        headers={
            'Content-Disposition': f'attachment; filename="{filename}"',
            'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'Access-Control-Allow-Origin': '*',
        },
    )


def _handle_cleanup(customer_id: str) -> func.HttpResponse:
    all_reports = cosmos_client.list_reports(customer_id)
    to_delete = [
        r for r in all_reports
        if r.source not in ('manual_import', 'dashboard_narrative')
        and r.status == 'draft'
        and not (r.joelNotes or '').strip()
        and not r.extractedData
    ]
    deleted = 0
    for r in to_delete:
        try:
            cosmos_client.delete_report(r.id, customer_id)
            deleted += 1
        except Exception as exc:
            logging.warning('Failed to delete report %s: %s', r.id, exc)
    logging.info('Cleaned up %d empty drafts for %s', deleted, customer_id)
    return cors_response({'deleted': deleted})
