import json
import logging
from datetime import datetime

import azure.functions as func

from shared import cosmos_client

_CACHE_SRC = 'dashboard_narrative'


def _json(body, status: int = 200) -> func.HttpResponse:
    return func.HttpResponse(json.dumps(body), status_code=status, mimetype='application/json')


def main(req: func.HttpRequest) -> func.HttpResponse:
    customer_id = (req.route_params.get('customerId') or '').strip()
    if not customer_id:
        return _json({'error': 'customerId is required'}, 400)

    try:
        customer = cosmos_client.get_customer(customer_id)
        if customer is None:
            return _json({'error': f'Customer {customer_id!r} not found'}, 404)

        # Determine the reporting period from trend data
        all_trends = cosmos_client.list_trends(customer_id)
        if not all_trends:
            return _json({'error': 'No trend data found for this customer'}, 404)

        latest_year = all_trends[0].year
        latest_month = all_trends[0].month
        prev_year = latest_year if latest_month > 1 else latest_year - 1
        prev_month = latest_month - 1 if latest_month > 1 else 12

        # Walk all reports and identify which ones were selected
        all_reports = cosmos_client.list_reports(customer_id)
        real_reports = [r for r in all_reports if r.source not in (_CACHE_SRC, None)]

        imported_curr = next(
            (r for r in real_reports
             if r.source == 'manual_import' and r.year == latest_year and r.month == latest_month),
            None,
        )
        imported_prev = next(
            (r for r in real_reports
             if r.source == 'manual_import' and r.year == prev_year and r.month == prev_month),
            None,
        )
        latest_generated = next(
            (r for r in real_reports if r.source == 'generated'),
            None,
        )

        def report_summary(r):
            if r is None:
                return None
            return {
                'id': r.id,
                'source': r.source,
                'month': r.month,
                'year': r.year,
                'generatedAt': r.generatedAt.isoformat(),
            }

        ed_prev = imported_prev.extractedData if imported_prev and imported_prev.extractedData else {}
        ed_curr = imported_curr.extractedData if imported_curr and imported_curr.extractedData else {}

        joel_notes = (latest_generated.joelNotes or '') if latest_generated else ''

        return _json({
            'customerId': customer_id,
            'customerName': customer.name,
            'reportingPeriod': {
                'year': latest_year,
                'month': latest_month,
                'label': datetime(latest_year, latest_month, 1).strftime('%B %Y'),
            },
            'selectedReports': {
                'importedCurrent': report_summary(imported_curr),
                'importedPrevious': report_summary(imported_prev),
                'latestGenerated': report_summary(latest_generated),
            },
            'rawContext': {
                'joelNotes': joel_notes,
                'nextSteps': ed_prev.get('nextSteps') or [],
                'ongoingNextSteps': ed_prev.get('ongoingNextSteps') or [],
                'plannedSavings': ed_prev.get('plannedSavings') or [],
                'projectUpdates': ed_prev.get('projectUpdates') or [],
                'progressNarrative': ed_prev.get('progressNarrative') or '',
                'realizedSavings': ed_curr.get('realizedSavings', 0.0),
            },
        })

    except Exception as exc:
        logging.exception('dashboard_context unhandled error')
        return _json({'error': str(exc)}, 500)
