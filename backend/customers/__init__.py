import json
import logging

import azure.functions as func

from shared import cosmos_client


def _json(body: dict, status: int = 200) -> func.HttpResponse:
    return func.HttpResponse(json.dumps(body), status_code=status, mimetype='application/json')


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('customers triggered')
    customers = cosmos_client.list_customers()
    return _json([c.to_dict() for c in customers])
