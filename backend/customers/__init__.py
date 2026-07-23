import logging
import re
import uuid
from datetime import datetime, timezone

import azure.functions as func

from shared import cosmos_client
from shared.models import Customer
from shared.response_helpers import CORS_HEADERS, cors_options, cors_response


def _handle_get(customer_id: str) -> func.HttpResponse:
    if customer_id:
        customer = cosmos_client.get_customer(customer_id)
        if customer is None:
            return cors_response({'error': f'Customer {customer_id!r} not found'}, 404)
        return cors_response(customer.to_dict())
    customers = cosmos_client.list_customers()
    return cors_response([c.to_dict() for c in customers])


def _handle_post(req: func.HttpRequest) -> func.HttpResponse:
    try:
        body = req.get_json()
    except ValueError:
        return cors_response({'error': 'Request body must be valid JSON'}, 400)

    name = (body.get('name') or '').strip()
    slug = (body.get('slug') or '').strip()

    if not name:
        return cors_response({'error': 'name is required'}, 400)
    if not slug:
        return cors_response({'error': 'slug is required'}, 400)
    if not re.fullmatch(r'[a-z0-9-]+', slug):
        return cors_response({'error': 'slug must contain only lowercase letters, numbers, and hyphens'}, 400)

    customer = Customer(
        id=str(uuid.uuid4()),
        name=name,
        slug=slug,
        created_at=datetime.now(timezone.utc),
        settings={},
    )
    cosmos_client.create_customer(customer)
    return cors_response(customer.to_dict(), 201)


_COMMITMENT_TYPES = {'EDP', 'SavingsPlan', 'EnterpriseAgreement', 'None'}
_COMMITMENT_FIELDS = [
    'commitmentType', 'commitmentAnnualValue', 'commitmentTermYears',
    'commitmentStartDate', 'commitmentEndDate', 'commitmentMonthlyObligation',
    'discountRate',
]


def _handle_patch(req: func.HttpRequest, customer_id: str) -> func.HttpResponse:
    if not customer_id:
        return cors_response({'error': 'customerId is required'}, 400)

    try:
        body = req.get_json()
    except ValueError:
        return cors_response({'error': 'Request body must be valid JSON'}, 400)

    customer = cosmos_client.get_customer(customer_id)
    if customer is None:
        return cors_response({'error': f'Customer {customer_id!r} not found'}, 404)

    commitment_type = body.get('commitmentType')
    if commitment_type is not None and commitment_type not in _COMMITMENT_TYPES:
        return cors_response(
            {'error': f'commitmentType must be one of {sorted(_COMMITMENT_TYPES)}'}, 400,
        )

    commitment = dict(customer.settings.get('commitment', {}))
    for field in _COMMITMENT_FIELDS:
        if field in body:
            commitment[field] = body[field]
    customer.settings = {**customer.settings, 'commitment': commitment}

    cosmos_client.update_customer(customer)
    return cors_response(customer.to_dict())


def _handle_delete(customer_id: str) -> func.HttpResponse:
    if not customer_id:
        return cors_response({'error': 'customerId is required'}, 400)
    cosmos_client.delete_customer(customer_id)
    return func.HttpResponse(status_code=204, headers=CORS_HEADERS)


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('customers triggered: %s %s', req.method, req.url)
    customer_id = (req.route_params.get('customerId') or '').strip()
    if req.method == 'OPTIONS':
        return cors_options()
    try:
        if req.method == 'DELETE':
            return _handle_delete(customer_id)
        if req.method == 'POST':
            return _handle_post(req)
        if req.method == 'PATCH':
            return _handle_patch(req, customer_id)
        return _handle_get(customer_id)
    except Exception as exc:
        logging.exception('customers unhandled error')
        return cors_response({'error': str(exc)}, 500)
