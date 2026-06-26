import logging

import azure.functions as func

from shared import cosmos_client
from shared.response_helpers import cors_options, cors_response


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('list_uploads triggered')
    if req.method == 'OPTIONS':
        return cors_options()
    try:
        return _handle(req)
    except Exception as exc:
        logging.exception('list_uploads unhandled error')
        return cors_response({'error': str(exc)}, 500)


def _handle(req: func.HttpRequest) -> func.HttpResponse:
    customer_id = req.route_params.get('customerId', '').strip()
    if not customer_id:
        return cors_response({'error': 'customerId route parameter is required'}, 400)

    uploads = cosmos_client.list_uploads(customer_id)
    return cors_response([u.to_dict() for u in uploads])
