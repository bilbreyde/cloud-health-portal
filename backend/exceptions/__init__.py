import json
import logging
import math
import uuid
from datetime import datetime, timezone
from io import BytesIO

import azure.functions as func
import pandas as pd

from shared import cosmos_client
from shared.models import ExceptionRecord, derive_exception_category


def _json(body, status: int = 200) -> func.HttpResponse:
    return func.HttpResponse(json.dumps(body), status_code=status, mimetype='application/json')


def _clean_str(v, default: str = '') -> str:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return default
    return str(v).strip()


def _clean_float(v, default: float = 0.0) -> float:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return default
    try:
        s = str(v).replace('$', '').replace(',', '').strip()
        return float(s)
    except (ValueError, TypeError):
        return default


def _row_to_exception(row: dict, customer_id: str, now: datetime) -> ExceptionRecord:
    """Map an imported row dict (column names from xlsx) to ExceptionRecord."""
    instance_id = _clean_str(row.get('Instance Id') or row.get('instanceId'))
    instance_name = _clean_str(
        row.get('Instance Name') or row.get('instanceName') or row.get('Name') or instance_id
    )
    product = _clean_str(row.get('Product') or row.get('product'))

    # Deterministic ID: stable across re-imports of the same instance
    doc_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{customer_id}:{instance_id}")) if instance_id \
        else str(uuid.uuid4())

    return ExceptionRecord(
        id=doc_id,
        customerId=customer_id,
        instanceId=instance_id,
        instanceName=instance_name,
        accountName=_clean_str(row.get('Account Name') or row.get('accountName')),
        appOwner=_clean_str(row.get('AppOwner') or row.get('appOwner')),
        product=product,
        lifecycle=_clean_str(row.get('Lifecycle') or row.get('lifecycle')),
        notes=_clean_str(row.get('Notes') or row.get('notes')),
        pricePerHour=_clean_float(row.get('Price Per Hour') or row.get('pricePerHour')),
        projectedCostPerMonth=_clean_float(
            row.get('Projected Cost For Month') or row.get('projectedCostPerMonth')
        ),
        state=_clean_str(row.get('State') or row.get('state')),
        apiName=_clean_str(row.get('API Name') or row.get('apiName')),
        serverRole=_clean_str(row.get('ServerRole') or row.get('serverRole')),
        portfolioName=_clean_str(row.get('PortfolioName') or row.get('portfolioName')),
        exceptionCategory=derive_exception_category(product),
        createdAt=now,
        updatedAt=now,
    )


def _handle_list(customer_id: str) -> func.HttpResponse:
    exc_list = cosmos_client.list_exceptions(customer_id)
    return _json([e.to_dict() for e in exc_list])


def _handle_summary(customer_id: str) -> func.HttpResponse:
    summary = cosmos_client.exceptions_summary(customer_id)
    return _json(summary)


def _handle_import(req: func.HttpRequest, customer_id: str) -> func.HttpResponse:
    now = datetime.now(timezone.utc)

    # Accept multipart file upload (xlsx or csv)
    file_bytes = req.files.get('file')
    if file_bytes:
        content = file_bytes.read()
        filename = (file_bytes.filename or '').lower()
        if filename.endswith('.csv'):
            df = pd.read_csv(BytesIO(content))
        else:
            df = pd.read_excel(BytesIO(content), engine='openpyxl')
        rows = df.where(pd.notna(df), None).to_dict(orient='records')
    else:
        # Fall back to JSON array body
        try:
            rows = req.get_json()
            if not isinstance(rows, list):
                return _json({'error': 'Expected a JSON array or multipart file'}, 400)
        except ValueError:
            return _json({'error': 'Request must be multipart file upload or JSON array'}, 400)

    upserted = 0
    errors = []
    for i, row in enumerate(rows):
        try:
            exc = _row_to_exception(row, customer_id, now)
            cosmos_client.upsert_exception(exc)
            upserted += 1
        except Exception as e:
            errors.append({'row': i, 'error': str(e)})

    return _json({'imported': upserted, 'errors': errors}, 200)


def _handle_put(req: func.HttpRequest, customer_id: str, exception_id: str) -> func.HttpResponse:
    try:
        body = req.get_json()
    except ValueError:
        return _json({'error': 'Request body must be valid JSON'}, 400)

    exc = cosmos_client.get_exception(exception_id, customer_id)
    if exc is None:
        return _json({'error': f'Exception {exception_id!r} not found'}, 404)

    if 'notes' in body:
        exc.notes = (body['notes'] or '').strip()
    if 'exceptionCategory' in body:
        exc.exceptionCategory = (body['exceptionCategory'] or '').strip()
    exc.updatedAt = datetime.now(timezone.utc)

    cosmos_client.upsert_exception(exc)
    return _json(exc.to_dict())


def _handle_delete(customer_id: str, exception_id: str) -> func.HttpResponse:
    exc = cosmos_client.get_exception(exception_id, customer_id)
    if exc is None:
        return _json({'error': f'Exception {exception_id!r} not found'}, 404)
    cosmos_client.delete_exception(exception_id, customer_id)
    return func.HttpResponse(status_code=204)


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('exceptions triggered: %s %s', req.method, req.url)
    customer_id = (req.route_params.get('customerId') or '').strip()
    action = (req.route_params.get('action') or '').strip()

    if not customer_id:
        return _json({'error': 'customerId is required'}, 400)

    try:
        method = req.method.upper()

        if method == 'GET' and action == 'summary':
            return _handle_summary(customer_id)
        if method == 'GET' and not action:
            return _handle_list(customer_id)
        if method == 'POST' and action == 'import':
            return _handle_import(req, customer_id)
        if method == 'PUT' and action:
            return _handle_put(req, customer_id, action)
        if method == 'DELETE' and action:
            return _handle_delete(customer_id, action)

        return _json({'error': f'Unrecognised route: {method} /exceptions/{customer_id}/{action}'}, 404)

    except Exception as exc:
        logging.exception('exceptions unhandled error')
        return _json({'error': str(exc)}, 500)
