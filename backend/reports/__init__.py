import json
import logging

import azure.functions as func

from shared import cosmos_client


def _json(body: dict, status: int = 200) -> func.HttpResponse:
    return func.HttpResponse(json.dumps(body), status_code=status, mimetype='application/json')


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('reports triggered')

    customer_id = req.route_params.get('customerId', '').strip()
    if not customer_id:
        return _json({'error': 'customerId route parameter is required'}, 400)

    reports = cosmos_client.list_reports(customer_id)
    return _json([r.to_dict() for r in reports])
