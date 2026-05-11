import json
import logging

import azure.functions as func

from shared import cosmos_client


def _json(body, status: int = 200) -> func.HttpResponse:
    return func.HttpResponse(json.dumps(body), status_code=status, mimetype='application/json')


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('list_uploads triggered')
    try:
        return _handle(req)
    except Exception as exc:
        logging.exception('list_uploads unhandled error')
        return _json({'error': str(exc)}, 500)


def _handle(req: func.HttpRequest) -> func.HttpResponse:
    customer_id = req.route_params.get('customerId', '').strip()
    if not customer_id:
        return _json({'error': 'customerId route parameter is required'}, 400)

    uploads = cosmos_client.list_uploads(customer_id)
    return _json([u.to_dict() for u in uploads])
