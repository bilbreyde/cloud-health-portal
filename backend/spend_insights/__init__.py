import logging
import os
from datetime import date, datetime, timedelta, timezone

import azure.functions as func
from openai import AzureOpenAI

from shared import cosmos_client
from shared.models import Report
from shared.response_helpers import cors_options, cors_response
from shared.cost_classifier import should_suppress_for_partial_month
from shared.spend_insights_engine import (
    compute_anomalies,
    compute_commitment_utilization,
    compute_coverage_analysis,
    compute_correlations,
    compute_opportunities,
    last_n_months,
    month_day_counts,
)

_CACHE_TTL_HOURS = 24
_CACHE_SRC = 'spend_insights'
_WINDOW_MONTHS = 6


def _cache_id(customer_id: str, month: str) -> str:
    return f'insights-{customer_id}-{month}'


def _get_cache(customer_id: str, month: str) -> Report | None:
    try:
        cached = cosmos_client.get_report(_cache_id(customer_id, month), customer_id)
    except Exception:
        return None
    if cached is None or cached.source != _CACHE_SRC:
        return None
    gen_at = cached.generatedAt
    if gen_at.tzinfo is None:
        gen_at = gen_at.replace(tzinfo=timezone.utc)
    if datetime.now(timezone.utc) - gen_at > timedelta(hours=_CACHE_TTL_HOURS):
        return None
    return cached


def _save_cache(customer_id: str, month: str, payload: dict) -> None:
    year_n, month_n = (int(x) for x in month.split('-'))
    report = Report(
        id=_cache_id(customer_id, month),
        customerId=customer_id,
        month=month_n,
        year=year_n,
        status='cached',
        blobPath='',
        generatedAt=datetime.now(timezone.utc),
        source=_CACHE_SRC,
        narrativeDraft=payload['narrative'],
        extractedData=payload,
    )
    cosmos_client.update_report(report)


def _fmt(n: float) -> str:
    return f'${n:,.2f}'




def _anomaly_lines(anomalies: list) -> str:
    return '\n'.join(
        f"  - {a['service']}: {_fmt(a['currentAmount'])} [{a.get('flagType') or a['type']}] — {a['explanation']}"
        for a in anomalies
    ) or '  (none detected)'


def _correlation_lines(correlations: list) -> str:
    return '\n'.join(
        f"  - {c['service']}: spend {c['spendTrend']}, signal {c['signalTrend']} — {c['interpretation']}"
        for c in correlations
    ) or '  (no comparable signal data)'


def _opportunity_lines(opportunities: list) -> str:
    return '\n'.join(
        f"  - [{o['priority']}] {o['service']} ({o['category']}): current {_fmt(o['currentCost'])}, "
        f"est. savings {_fmt(o['estimatedSavings']) if o['estimatedSavings'] > 0 else 'N/A — risk mitigation'} "
        f"— {o['action']}"
        for o in opportunities
    ) or '  (none identified)'


def _build_prompt(
    customer_name: str,
    total_spend: float,
    mom_change: float | None,
    mom_pct: float | None,
    coverage_pct: float | None,
    commitment_utilization: dict | None,
    anomalies: list,
    correlations: list,
    opportunities: list,
    is_partial: bool,
    sp_unused: float,
) -> str:
    anomaly_lines = _anomaly_lines(anomalies)
    correlation_lines = _correlation_lines(correlations)
    opportunity_lines = _opportunity_lines(opportunities)
    mom_pct_str = f'{mom_pct:+.1f}%' if mom_pct is not None else 'n/a'
    mom_change_str = _fmt(mom_change) if mom_change is not None else 'n/a (no complete prior month to compare)'
    # SP Unused is billing-lag-distorted mid-month — never show the AI a live figure for
    # it on a partial month, so it can't hallucinate trend commentary about a number that
    # hasn't settled yet.
    sp_unused_line = (
        f'SP Unused: {_fmt(sp_unused)}' if not is_partial
        else 'SP Unused: Not shown — pending month-end true-up'
    )

    if commitment_utilization is not None:
        cu = commitment_utilization
        return f"""You are a senior AWS cost optimization consultant analyzing spend for {customer_name}.

BILLING CONTEXT:
- {customer_name} has a {cu.get('commitmentTermYears')}-year {cu.get('commitmentType')} commitment at \
{_fmt(cu.get('commitmentAnnualValue') or 0.0)}/year ({_fmt(cu['monthlyObligation'])}/month)
- Net spend toward EDP this month: {_fmt(cu['netTowardEdp'])} ({cu['utilizationPct']:.1f}% of obligation) — \
this is an EDP spend commitment, so Marketplace, Enterprise Support, and other one-time charges ALL count \
toward it, not just recurring infrastructure
  Infrastructure: {_fmt(cu['infrastructureSpend'])} · Marketplace: {_fmt(cu['marketplaceSpend'])} · \
Other one-time: {_fmt(cu['oneTimeSpend'])}
- AWS-applied credits/negations excluded from utilization: {_fmt(cu['creditsApplied'])}
- {sp_unused_line}
- Status: {cu.get('statusLabel')}

ANOMALIES THIS MONTH:
{anomaly_lines}

For each anomaly, provide context:
- Amazon Marketplace charges are one-time license purchases (e.g. Zscaler). Do not treat as trending, but
  note that the dollar amount DOES count toward the EDP commitment.
- Savings Plan Unused indicates committed capacity not being consumed. On EDP this is double-waste —
  flag as priority concern.
- Enterprise Support is a flat monthly fee — counts toward EDP, not a trend signal.
- AWS Partner Pricing Adjustment is a billing correction that counts toward EDP — not recurring infrastructure.

THRESHOLD-BASED OPPORTUNITIES:
{opportunity_lines}

EDP BURN RATE (last 3 complete months: {', '.join(cu.get('monthsUsed') or [])}):
- Trailing avg incl. software licensing (all spend minus AWS credits, Marketplace included): \
{_fmt(cu.get('trailing3MoAvg') or 0.0)} ({cu.get('trailingUtilizationPct') if cu.get('trailingUtilizationPct') is not None else 'n/a'}% of obligation)
- Trailing avg infrastructure only (Marketplace excluded — irregular, not a renewal-health signal): \
{_fmt(cu.get('infraTrailingAvg') or 0.0)} ({cu.get('infraTrailingPct') if cu.get('infraTrailingPct') is not None else 'n/a'}% of obligation)
Monthly obligation: {_fmt(cu['monthlyObligation'])}
Status (based on infrastructure-only trailing avg — Marketplace purchases are irregular and must not make \
a burn rate look healthy when the underlying recurring spend wouldn't support it): {cu.get('statusLabel')}

SIGNAL VS SPEND CORRELATIONS:
{correlation_lines}

Generate 5-7 specific, prioritized insights. Format each as:
PRIORITY [Critical/High/Medium/Low]: [Title]
Situation: [specific numbers]
Meaning: [business impact]
Action: [specific recommendation]
Est. Savings: [dollar amount or "N/A — risk mitigation"]

Lead with the highest-priority items. The EDP burn rate and unused Savings Plans are more urgent than
compute right-sizing in this context.
Be specific — name services, amounts, and account IDs where relevant."""

    return f"""You are a senior AWS cost optimization consultant analyzing spend data for {customer_name}.

Billing data analysis:
Total monthly spend: {_fmt(total_spend)}
MoM change: {mom_change_str} ({mom_pct_str})
Savings Plan coverage: {coverage_pct:.1f}% (target: 70-80%)
{sp_unused_line}

Anomalies detected:
{anomaly_lines}
(These are statistically unusual — explain each one and what it likely means)

Signal vs Spend correlation:
{correlation_lines}
(Explain what the gaps between CloudHealth signal and actual spend mean)

Identified optimization opportunities beyond CloudHealth:
{opportunity_lines}

Generate 4-6 specific, actionable insights. Each insight should:
1. Name the specific service or metric
2. State the current situation with exact dollar figures
3. Explain what it means for the business
4. Give a specific recommendation with estimated savings impact

Be direct and specific. Avoid generic advice.
Reference actual service names and dollar amounts from the data.
The audience is the customer's IT finance team and AWS engagement manager."""


def _handle_get(req: func.HttpRequest, customer_id: str) -> func.HttpResponse:
    customer = cosmos_client.get_customer(customer_id)
    if customer is None:
        return cors_response({'error': f'Customer {customer_id!r} not found'}, 404)

    month = (req.params.get('month') or '').strip() or date.today().strftime('%Y-%m')
    force = (req.params.get('bust', '').lower() == 'true') or (req.params.get('force', '').lower() == 'true')

    if not force:
        cached = _get_cache(customer_id, month)
        if cached:
            payload = dict(cached.extractedData or {})
            gen_at = cached.generatedAt
            if gen_at.tzinfo is None:
                gen_at = gen_at.replace(tzinfo=timezone.utc)
            payload['generatedAt'] = gen_at.isoformat()
            payload['cached'] = True
            return cors_response(payload)

    window_months = last_n_months(month, _WINDOW_MONTHS)
    all_records = cosmos_client.get_cost_history(customer_id, window_months[0], window_months[-1])
    available_months = {r.month for r in all_records}
    months_in_window = [m for m in window_months if m in available_months]
    if not months_in_window:
        return cors_response({'error': f'No cost history data found for the period ending {month}'}, 404)

    cost_summary = cosmos_client.get_cost_history_summary(customer_id, months_in_window)
    by_service = cost_summary['byService']
    current_month = months_in_window[-1]

    all_trends = cosmos_client.list_trends(customer_id)
    trend_dicts = [
        {'serviceType': t.serviceType, 'month': t.month, 'year': t.year, 'savingsTotal': t.savingsTotal}
        for t in all_trends
        if f'{t.year:04d}-{t.month:02d}' in months_in_window
    ]

    exc_summary = None
    try:
        exc_summary = cosmos_client.exceptions_summary(customer_id)
    except Exception as exc:
        logging.warning('spend_insights: exception summary fetch failed (non-fatal): %s', exc)

    commitment = (customer.settings or {}).get('commitment') or {}
    has_commitment = bool(commitment.get('commitmentType')) and commitment['commitmentType'] != 'None'

    # Single source of truth for "how much of the current month has elapsed" — computed
    # once in get_cost_history_summary and threaded through every calculation below so
    # a mid-month snapshot is never compared raw against a full prior month.
    is_partial = cost_summary['isPartial']
    completion_ratio = cost_summary['completionRatio']

    # SP/RI true-up lines (Savings Plan Unused, SP/RI Negation, ...) are billing-lag
    # artifacts on a partial month — get_cost_history_summary already drops them from
    # by_service's current-month values, but filter explicitly here too so anomaly
    # detection never sees them for the current month even if it's fed a different
    # by_service shape in the future.
    services_data = by_service
    if is_partial:
        services_data = [s for s in by_service if not should_suppress_for_partial_month(s['service'])]

    anomalies = compute_anomalies(services_data, months_in_window, is_partial, completion_ratio)
    correlations = compute_correlations(by_service, trend_dicts, months_in_window, is_partial, completion_ratio)

    coverage_analysis = None
    commitment_utilization = None
    if has_commitment:
        commitment_utilization = compute_commitment_utilization(
            commitment, cost_summary['monthlyTotals'], months_in_window, by_service,
            is_partial, completion_ratio,
        )
    else:
        coverage_analysis = compute_coverage_analysis(
            cost_summary['savingsPlanCoverage'], by_service, months_in_window, is_partial, completion_ratio)

    opportunities = compute_opportunities(
        by_service, coverage_analysis, current_month,
        months_in_window=months_in_window,
        monthly_obligation=commitment_utilization['monthlyObligation'] if commitment_utilization else None,
        skip_savings_plan_opportunity=has_commitment,
        is_partial=is_partial, completion_ratio=completion_ratio,
    )

    monthly_totals = {m['month']: m for m in cost_summary['monthlyTotals']}
    current_totals = monthly_totals.get(current_month, {})
    # MoM must compare INFRASTRUCTURE spend only (rule 8) — never total/net billed,
    # which still carries Marketplace and other one-time charges. Use the projected
    # full-month infrastructure figure, which equals the raw amount whenever the
    # month is closed. The prior month must be a COMPLETE month; if it isn't (e.g. a
    # short/gapped window), MoM is not computable and is reported as None rather than
    # comparing against a distorted partial figure.
    total_spend = current_totals.get('projectedInfrastructureSpend', current_totals.get('infrastructureSpend', 0.0))
    prior_month = months_in_window[-2] if len(months_in_window) >= 2 else None
    prior_totals = monthly_totals.get(prior_month, {}) if prior_month else {}
    prior_month_complete = bool(prior_totals) and not prior_totals.get('isPartial', False)
    prior_spend = prior_totals.get('infrastructureSpend', 0.0) if prior_month_complete else None
    mom_change = (total_spend - prior_spend) if prior_spend is not None else None
    mom_pct = (mom_change / prior_spend * 100) if (mom_change is not None and prior_spend) else None

    def _current_month_val(name: str) -> float:
        svc = next((s for s in by_service if s['service'].strip().lower() == name.lower()), None)
        return svc['months'].get(current_month, 0.0) if svc else 0.0

    # 0.0 automatically on a partial month — get_cost_history_summary already omits
    # these services' current-month value from by_service (rules 4/11).
    sp_unused = _current_month_val('Savings Plan - Unused') + _current_month_val('Database Savings Plan - Unused')

    prompt = _build_prompt(
        customer_name=customer.name,
        total_spend=total_spend,
        mom_change=mom_change,
        mom_pct=mom_pct,
        coverage_pct=coverage_analysis['currentPct'] if coverage_analysis else None,
        commitment_utilization=commitment_utilization,
        anomalies=anomalies,
        correlations=correlations,
        opportunities=opportunities,
        is_partial=is_partial,
        sp_unused=sp_unused,
    )
    if is_partial:
        days_elapsed, days_in_month = month_day_counts(current_month)
        completion_pct = round(days_elapsed / days_in_month * 100, 1)
        prompt += (
            f"\n\nCurrent month ({current_month}) is {days_elapsed} of {days_in_month} days complete "
            f"({completion_pct}% of month). The spend figures shown are PROJECTED to full month based "
            f"on the prior full day's run rate (stabilized to avoid intraday swings). Do not flag "
            f"partial month spend as anomalies — compare only projected figures to prior full months."
        )
    marketplace_events = [
        (m['month'], p)
        for m in cost_summary['monthlyTotals']
        for p in m.get('marketplacePurchases', [])
    ]
    if marketplace_events:
        event_lines = '\n'.join(
            f"{m}: {p.get('vendorNote') or 'Unidentified purchase'} — {_fmt(p['amount'])}"
            for m, p in marketplace_events
        )
        prompt += (
            f"\n\nSoftware licensing events (excluded from infrastructure trend):\n{event_lines}\n"
            f"These are one-time AWS Marketplace purchases, not recurring infrastructure. "
            f"Reference them by vendor name when they appear in the reporting period."
        )
    if exc_summary and exc_summary.get('totalCount', 0) > 0:
        prompt += (
            f"\n\nException floor context: {exc_summary['totalCount']} servers excluded from "
            f"optimization scope, {_fmt(exc_summary['totalMonthlyCost'])}/month total."
        )

    narrative = ''
    try:
        ai_client = AzureOpenAI(
            azure_endpoint=os.environ['AI_ENDPOINT'],
            api_key=os.environ.get('AI_API_KEY', ''),
            api_version='2024-12-01-preview',
        )
        completion = ai_client.chat.completions.create(
            model=os.environ.get('AI_DEPLOYMENT_NAME', 'gpt-5.1'),
            messages=[
                {'role': 'system', 'content': (
                    'You are a senior AWS cost optimization consultant. Write in prose, not JSON. '
                    'Use exact dollar figures and real service names from the data provided.'
                )},
                {'role': 'user', 'content': prompt},
            ],
            temperature=0.3,
        )
        narrative = completion.choices[0].message.content or ''
    except Exception as exc:
        logging.error('spend_insights: OpenAI call failed: %s', exc)

    now_utc = datetime.now(timezone.utc)
    payload = {
        'anomalies': anomalies,
        'coverageAnalysis': coverage_analysis,
        'commitmentUtilization': commitment_utilization,
        'correlations': correlations,
        'opportunities': opportunities,
        'narrative': narrative,
        'month': current_month,
        'totalSpend': round(total_spend, 2),
        'actualSpendToDate': round(current_totals.get('netBilled', current_totals.get('netCost', 0.0)), 2),
        'momChange': round(mom_change, 2) if mom_change is not None else None,
        'momPct': round(mom_pct, 2) if mom_pct is not None else None,
        'isPartial': is_partial,
        'completionRatio': round(completion_ratio, 4),
        'generatedAt': now_utc.isoformat(),
        'cached': False,
    }
    _save_cache(customer_id, month, payload)

    return cors_response(payload)


def _handle_patch(req: func.HttpRequest, customer_id: str) -> func.HttpResponse:
    """"Add to Report" — saves the (possibly edited) narrative into the current
    'generated' report for that month/year, alongside the other report narrative sections."""
    try:
        body = req.get_json()
    except ValueError:
        return cors_response({'error': 'Request body must be valid JSON'}, 400)

    month_str = (body.get('month') or '').strip()
    narrative = body.get('narrative')
    if not month_str or narrative is None:
        return cors_response({'error': 'month and narrative are required'}, 400)

    try:
        year_n, month_n = (int(x) for x in month_str.split('-'))
    except ValueError:
        return cors_response({'error': 'month must be in YYYY-MM format'}, 400)

    all_reports = cosmos_client.list_reports(customer_id, year=year_n)
    report = next(
        (r for r in all_reports if r.source == 'generated' and r.month == month_n and r.year == year_n),
        None,
    )
    if report is None:
        return cors_response(
            {'error': f'No generated report found for {month_str}. Generate a report for this period first.'},
            404,
        )

    ext = report.extractedData or {}
    ext['spendInsightsNarrative'] = narrative
    report.extractedData = ext
    cosmos_client.update_report(report)

    return cors_response({'success': True})


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('spend_insights triggered: %s %s', req.method, req.url)
    customer_id = (req.route_params.get('customerId') or '').strip()

    if req.method == 'OPTIONS':
        return cors_options()
    if not customer_id:
        return cors_response({'error': 'customerId is required'}, 400)

    try:
        if req.method == 'GET':
            return _handle_get(req, customer_id)
        if req.method == 'PATCH':
            return _handle_patch(req, customer_id)
        return cors_response({'error': 'Method not allowed'}, 405)
    except Exception as exc:
        logging.exception('spend_insights unhandled error')
        return cors_response({'error': str(exc)}, 500)
