import json
import logging
import re
import uuid
from datetime import datetime, timezone

import azure.functions as func

from shared import cosmos_client
from shared.models import Customer


def _json(body, status: int = 200) -> func.HttpResponse:
    return func.HttpResponse(json.dumps(body), status_code=status, mimetype='application/json')


def _handle_get(customer_id: str) -> func.HttpResponse:
    if customer_id:
        customer = cosmos_client.get_customer(customer_id)
        if customer is None:
            return _json({'error': f'Customer {customer_id!r} not found'}, 404)
        return _json(customer.to_dict())
    customers = cosmos_client.list_customers()
    return _json([c.to_dict() for c in customers])


def _handle_post(req: func.HttpRequest) -> func.HttpResponse:
    try:
        body = req.get_json()
    except ValueError:
        return _json({'error': 'Request body must be valid JSON'}, 400)

    name = (body.get('name') or '').strip()
    slug = (body.get('slug') or '').strip()

    if not name:
        return _json({'error': 'name is required'}, 400)
    if not slug:
        return _json({'error': 'slug is required'}, 400)
    if not re.fullmatch(r'[a-z0-9-]+', slug):
        return _json({'error': 'slug must contain only lowercase letters, numbers, and hyphens'}, 400)

    customer = Customer(
        id=str(uuid.uuid4()),
        name=name,
        slug=slug,
        created_at=datetime.now(timezone.utc),
        settings={},
    )
    cosmos_client.create_customer(customer)
    return _json(customer.to_dict(), 201)


def _handle_delete(customer_id: str) -> func.HttpResponse:
    if not customer_id:
        return _json({'error': 'customerId is required'}, 400)
    cosmos_client.delete_customer(customer_id)
    return func.HttpResponse(status_code=204)


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('customers triggered: %s %s', req.method, req.url)
    customer_id = (req.route_params.get('customerId') or '').strip()
    try:
        if req.method == 'DELETE':
            return _handle_delete(customer_id)
        if req.method == 'POST':
            return _handle_post(req)
        return _handle_get(customer_id)
    except Exception as exc:
        logging.exception('customers unhandled error')
        return _json({'error': str(exc)}, 500)
