import json
import logging
import os
import uuid
from datetime import datetime, timezone

import azure.functions as func
from openai import AzureOpenAI

from shared import cosmos_client
from shared.models import Report
from shared.trend_engine import SMALL_DELTA_ABS, compute_mom_delta


def _json(body: dict, status: int = 200) -> func.HttpResponse:
    return func.HttpResponse(json.dumps(body), status_code=status, mimetype='application/json')


def _prev_month(month: int, year: int):
    return (12, year - 1) if month == 1 else (month - 1, year)


def _build_user_prompt(
    customer_name: str, month: int, year: int,
    curr_data: dict, prev_data: dict,
    classifications: dict,
    top_movers_up: list, top_movers_down: list,
    joel_notes: str,
    exception_summary: dict | None = None,
    prev_next_steps: list | None = None,
    realized_savings: float = 0.0,
) -> str:
    month_label = datetime(year, month, 1).strftime('%B %Y')
    total_signal = sum(curr_data.values())
    exc_floor = exception_summary['totalMonthlyCost'] if exception_summary else 0.0
    net_addressable = max(0.0, total_signal - exc_floor)

    lines = [
        f"Customer: {customer_name}",
        f"Reporting Period: {month_label}",
        "",
        "Current Month Savings Signal by Service:",
    ]
    for svc, total in sorted(curr_data.items()):
        badge = f" [{classifications[svc]}]" if svc in classifications else ""
        lines.append(f"  {svc}: ${total:,.2f}{badge}")

    if top_movers_up:
        lines.append("\nServices with Increased Spend (Top Movers Up):")
        for m in top_movers_up[:5]:
            lines.append(f"  {m['serviceType']}: +${m['momDelta']:,.2f} MoM")

    if top_movers_down:
        lines.append("\nServices with Decreased Spend / Savings (Top Movers Down):")
        for m in top_movers_down[:5]:
            lines.append(f"  {m['serviceType']}: ${m['momDelta']:,.2f} MoM")

    if exception_summary and exception_summary.get('totalCount', 0) > 0:
        top_cats = exception_summary.get('byCategory', [])[:3]
        lines.append(
            "\nException Floor (business-critical servers excluded from optimization):"
        )
        lines.append(
            f"  {exception_summary['totalCount']} servers, "
            f"${exc_floor:,.2f}/month total"
        )
        if top_cats:
            lines.append("  Top categories:")
            for cat in top_cats:
                lines.append(
                    f"    {cat['category']}: {cat['count']} servers, ${cat['monthlyCost']:,.2f}/month"
                )

    # Exception & signal delta data for the dedicated narrative section
    lines.append("\nException & Signal Delta Summary:")
    lines.append(f"  CloudHealth Signal (theoretical max): ${total_signal:,.2f}")
    lines.append(f"  Exception Floor (cannot optimize):    ${exc_floor:,.2f}")
    lines.append(f"  Net Addressable Opportunity:          ${net_addressable:,.2f}")
    if realized_savings > 0:
        lines.append(f"  Realized Savings (confirmed executed): ${realized_savings:,.2f}")
        lines.append(f"  Remaining Opportunity:                ${max(0.0, net_addressable - realized_savings):,.2f}")

    if prev_next_steps:
        lines.append("\nPreviously Committed Next Steps (from last report — confirm which were completed):")
        for step in prev_next_steps[:10]:
            lines.append(f"  • {step}")

    if joel_notes:
        lines.append(f"\nEngagement Manager Notes to incorporate:\n{joel_notes}")

    lines.append("""
Generate a formal cloud cost optimization consulting report.
Return a JSON object with exactly these five string keys:
  "executive_summary"          - 2 to 3 paragraph executive summary
  "optimization_narrative"     - detailed analysis of cost drivers and opportunities
  "top_movers_analysis"        - analysis of the top spending increases and decreases
  "risks_and_next_steps"       - identified risks and recommended next steps
  "exception_delta"            - 2-3 professional paragraphs explaining the gap between
                                 CloudHealth signal and realized savings:
                                 (1) state gross signal as theoretical max,
                                 (2) subtract exception floor and name the top locked categories,
                                 (3) state net addressable opportunity,
                                 (4) reference realized savings as confirmed executed actions only,
                                 (5) state remaining addressable opportunity.
                                 Tone: professional consultant, matter-of-fact — the gap is expected
                                 and normal for an enterprise AWS fleet.

Return only the JSON object. No markdown fences, no extra keys.""")

    return '\n'.join(lines)


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('build_report triggered')

    try:
        body = req.get_json()
    except ValueError:
        return _json({'error': 'Request body must be valid JSON'}, 400)

    customer_id = (body.get('customerId') or '').strip()
    month = body.get('month')
    year = body.get('year')
    joel_notes = (body.get('joelNotes') or '').strip()

    if not customer_id:
        return _json({'error': 'customerId is required'}, 400)
    if not isinstance(month, int) or not isinstance(year, int):
        return _json({'error': 'month and year must be integers'}, 400)
    if not 1 <= month <= 12:
        return _json({'error': 'month must be 1-12'}, 400)

    # ── Validate customer ──────────────────────────────────────────────────────
    customer = cosmos_client.get_customer(customer_id)
    if customer is None:
        return _json({'error': f'Customer {customer_id!r} not found'}, 404)

    # ── Fetch trend data ───────────────────────────────────────────────────────
    all_trends = cosmos_client.list_trends(customer_id)
    curr_trends = [t for t in all_trends if t.year == year and t.month == month]
    if not curr_trends:
        return _json({'error': f'No trend data found for {month}/{year}'}, 404)

    prev_month_n, prev_year = _prev_month(month, year)
    prev_trends = [t for t in all_trends if t.year == prev_year and t.month == prev_month_n]

    curr_data = {t.serviceType: t.savingsTotal for t in curr_trends}
    prev_data = {t.serviceType: t.savingsTotal for t in prev_trends}

    # ── Imported report continuity ─────────────────────────────────────────────
    realized_savings = 0.0
    prev_next_steps: list = []

    try:
        all_reports = cosmos_client.list_reports(customer_id)
        imported_curr = next(
            (r for r in all_reports
             if r.source == 'manual_import' and r.year == year and r.month == month),
            None,
        )
        imported_prev = next(
            (r for r in all_reports
             if r.source == 'manual_import' and r.year == prev_year and r.month == prev_month_n),
            None,
        )

        if imported_curr and imported_curr.extractedData:
            realized_savings = float(imported_curr.extractedData.get('realizedSavings', 0.0))

        if imported_prev and imported_prev.extractedData:
            prev_next_steps = imported_prev.extractedData.get('nextSteps', []) or []
            # If no trend data for prev month, use imported monthlySavings for classification
            if not prev_trends:
                prev_data = imported_prev.extractedData.get('monthlySavings', {})
    except Exception as exc:
        logging.warning('Imported report lookup failed: %s', exc)

    # ── Compute MoM deltas and classify ───────────────────────────────────────
    top_movers_up: list = []
    top_movers_down: list = []
    classifications: dict = {}
    service_summary: list = []

    for svc, curr_total in curr_data.items():
        prev_total = prev_data.get(svc, 0.0)
        delta, direction = compute_mom_delta(curr_total, prev_total)

        if direction == 'Up':
            top_movers_up.append({'serviceType': svc, 'momDelta': delta, 'direction': direction})
        elif direction == 'Down':
            top_movers_down.append({'serviceType': svc, 'momDelta': delta, 'direction': direction})

        if abs(delta) > SMALL_DELTA_ABS:
            classifications[svc] = 'Persistent Issue' if svc in prev_data else 'New Insight'

        service_summary.append({
            'serviceType': svc,
            'savingsTotal': curr_total,
            'momDelta': delta,
            'direction': direction,
            'classification': classifications.get(svc, ''),
        })

    top_movers_up.sort(key=lambda x: -x['momDelta'])
    top_movers_down.sort(key=lambda x: x['momDelta'])

    # ── Exception floor ────────────────────────────────────────────────────────
    exception_summary: dict | None = None
    try:
        exception_summary = cosmos_client.exceptions_summary(customer_id)
    except Exception as exc:
        logging.warning('Could not fetch exception summary: %s', exc)

    # ── AI narrative generation ────────────────────────────────────────────────
    ai_client = AzureOpenAI(
        azure_endpoint=os.environ['AI_ENDPOINT'],
        api_key=os.environ.get('AI_API_KEY', ''),
        api_version='2024-12-01-preview',
    )

    system_prompt = (
        "You are a professional cloud cost optimization consultant writing a "
        "formal report for an enterprise client."
    )
    user_prompt = _build_user_prompt(
        customer.name, month, year, curr_data, prev_data,
        classifications, top_movers_up, top_movers_down, joel_notes,
        exception_summary=exception_summary,
        prev_next_steps=prev_next_steps,
        realized_savings=realized_savings,
    )

    narrative = {
        'executive_summary': '',
        'optimization_narrative': '',
        'top_movers_analysis': '',
        'risks_and_next_steps': '',
        'exception_delta': '',
    }
    try:
        completion = ai_client.chat.completions.create(
            model=os.environ.get('AI_DEPLOYMENT_NAME', 'gpt-5.1'),
            messages=[
                {'role': 'system', 'content': system_prompt},
                {'role': 'user', 'content': user_prompt},
            ],
            response_format={'type': 'json_object'},
            temperature=0.3,
        )
        narrative = json.loads(completion.choices[0].message.content)
    except Exception as exc:
        logging.error('OpenAI call failed: %s', exc)

    # ── Save Report to Cosmos ──────────────────────────────────────────────────
    report_id = str(uuid.uuid4())
    report = Report(
        id=report_id,
        customerId=customer_id,
        month=month,
        year=year,
        status='draft',
        blobPath='',
        generatedAt=datetime.now(timezone.utc),
        joelNotes=joel_notes or None,
        narrativeDraft=json.dumps(narrative),
        source='generated',
    )
    cosmos_client.create_report(report)

    exc_floor = exception_summary['totalMonthlyCost'] if exception_summary else 0.0
    total_signal = sum(curr_data.values())

    return _json({
        'success': True,
        'reportId': report_id,
        'narrativeDraft': narrative,
        'topMoversUp': top_movers_up[:5],
        'topMoversDown': top_movers_down[:5],
        'serviceSummary': service_summary,
        'totalExceptionCost': exc_floor,
        'topExceptionCategories': (exception_summary.get('byCategory', [])[:5] if exception_summary else []),
        'totalSignal': round(total_signal, 2),
        'realizedSavings': round(realized_savings, 2),
        'exceptionFloor': round(exc_floor, 2),
    })
