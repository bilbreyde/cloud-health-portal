import logging
import re

import azure.functions as func

from shared import cosmos_client
from shared.response_helpers import cors_options, cors_response

_MONTH_RE = re.compile(r'^\d{4}-\d{2}$')


def _to_dict(p) -> dict:
    return {
        'month': p.month,
        'amount': p.amount,
        'vendorNote': p.vendorNote,
        'hasNote': bool(p.vendorNote),
    }


def _handle_get(customer_id: str) -> func.HttpResponse:
    customer = cosmos_client.get_customer(customer_id)
    if customer is None:
        return cors_response({'error': f'Customer {customer_id!r} not found'}, 404)

    purchases = cosmos_client.list_marketplace_purchases(customer_id)
    return cors_response([_to_dict(p) for p in purchases])


def _handle_patch(req: func.HttpRequest, customer_id: str, month: str) -> func.HttpResponse:
    if not _MONTH_RE.match(month or ''):
        return cors_response({'error': 'month must be in YYYY-MM format'}, 400)

    customer = cosmos_client.get_customer(customer_id)
    if customer is None:
        return cors_response({'error': f'Customer {customer_id!r} not found'}, 404)

    try:
        body = req.get_json()
    except ValueError:
        return cors_response({'error': 'Request body must be valid JSON'}, 400)

    vendor_note = body.get('vendorNote')
    if vendor_note is None:
        return cors_response({'error': 'vendorNote is required'}, 400)

    updated = cosmos_client.update_marketplace_purchase_note(customer_id, month, str(vendor_note).strip())
    if updated is None:
        return cors_response({'error': f'No marketplace purchase found for {month}'}, 404)

    return cors_response(_to_dict(updated))


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('marketplace_purchases triggered: %s %s', req.method, req.url)
    customer_id = (req.route_params.get('customerId') or '').strip()
    month = (req.route_params.get('month') or '').strip()

    if req.method == 'OPTIONS':
        return cors_options()
    if not customer_id:
        return cors_response({'error': 'customerId is required'}, 400)

    try:
        method = req.method.upper()

        if method == 'GET' and not month:
            return _handle_get(customer_id)
        if method == 'PATCH' and month:
            return _handle_patch(req, customer_id, month)

        return cors_response(
            {'error': f'Unrecognised route: {method} /marketplace-purchases/{customer_id}/{month}'}, 404,
        )
    except Exception as exc:
        logging.exception('marketplace_purchases unhandled error')
        return cors_response({'error': str(exc)}, 500)
