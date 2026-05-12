import json
import logging
import os
import traceback
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


_SYSTEM_PROMPT = (
    "You are a professional cloud cost optimization consultant writing a formal monthly report "
    "for an enterprise client. You have access to context from the previous report cycle — "
    "including commitments made, projects in flight, and the engagement manager's notes. "
    "This context is GROUND TRUTH about work actually done; weight it heavily over raw signal data alone.\n\n"
    "When generating the report:\n"
    "- Reference what was committed last cycle and assess whether it appears completed based on signal changes.\n"
    "- Incorporate the planned savings pipeline into the optimization narrative — these are upcoming actions "
    "not yet reflected in CloudHealth signal.\n"
    "- If a migration or project was listed as pending or in progress, explicitly reference its current status "
    "and expected impact.\n"
    "- The manager notes describe actual executed actions and real business context — use them to explain "
    "signal movements that raw data alone cannot explain (e.g. a Domain Controller upsizing causing an EC2 bump "
    "is expected and should be framed as intentional, not alarming).\n"
    "- Realized savings are confirmed executed actions only; do not conflate with signal movement."
)


def _build_user_prompt(
    customer_name: str,
    month: int,
    year: int,
    curr_data: dict,
    prev_data: dict,
    classifications: dict,
    top_movers_up: list,
    top_movers_down: list,
    joel_notes: str,
    exception_summary: dict | None = None,
    prev_next_steps: list | None = None,
    realized_savings: float = 0.0,
    planned_savings: list | None = None,
    project_updates: list | None = None,
    progress_narrative: str = '',
    ongoing_next_steps: list | None = None,
) -> str:
    month_label    = datetime(year, month, 1).strftime('%B %Y')
    total_signal   = sum(curr_data.values())
    exc_floor      = exception_summary['totalMonthlyCost'] if exception_summary else 0.0
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
                    f"    {cat['category']}: {cat['count']} servers, "
                    f"${cat['monthlyCost']:,.2f}/month"
                )

    lines.append("\nException & Signal Delta Summary:")
    lines.append(f"  CloudHealth Signal (theoretical max): ${total_signal:,.2f}")
    lines.append(f"  Exception Floor (cannot optimize):    ${exc_floor:,.2f}")
    lines.append(f"  Net Addressable Opportunity:          ${net_addressable:,.2f}")
    if realized_savings > 0:
        lines.append(f"  Realized Savings (confirmed executed): ${realized_savings:,.2f}")
        lines.append(
            f"  Remaining Opportunity:                "
            f"${max(0.0, net_addressable - realized_savings):,.2f}"
        )

    # ── Previous cycle context ─────────────────────────────────────────────────
    if prev_next_steps:
        lines.append(
            "\nCommitments from Previous Cycle (assess completion based on signal movement):"
        )
        for step in prev_next_steps[:10]:
            lines.append(f"  • {step}")

    if ongoing_next_steps:
        lines.append("\nOngoing Recurring Commitments from Previous Cycle:")
        for step in ongoing_next_steps[:5]:
            lines.append(f"  • {step}")

    if planned_savings:
        lines.append(
            "\nUpcoming Planned Savings Pipeline "
            "(committed actions not yet executed — not in signal yet):"
        )
        for item in planned_savings[:10]:
            lines.append(f"  • {item}")

    if project_updates:
        lines.append(
            "\nActive Projects & Migration Status "
            "(reference these explicitly in the narrative):"
        )
        for item in project_updates[:8]:
            lines.append(f"  • {item}")

    if progress_narrative:
        lines.append(
            f"\nProgress Narrative from Previous Report "
            f"(ground truth — use to explain signal movements):\n{progress_narrative}"
        )

    if joel_notes:
        lines.append(
            f"\nEngagement Manager Notes for This Report "
            f"(incorporate directly — these describe actual work done):\n{joel_notes}"
        )

    lines.append("""
Generate a formal cloud cost optimization consulting report.
Return a JSON object with exactly these five string keys:
  "executive_summary"          - 2 to 3 paragraph executive summary
  "optimization_narrative"     - detailed analysis of cost drivers, completed actions, and opportunities;
                                 explicitly reference the planned savings pipeline and project statuses
  "top_movers_analysis"        - analysis of spending increases and decreases; explain movements using
                                 the manager notes and project context where relevant
  "risks_and_next_steps"       - identified risks and recommended next steps; distinguish one-time
                                 actions from ongoing commitments
  "exception_delta"            - 2-3 professional paragraphs explaining the gap between CloudHealth
                                 signal and realized savings:
                                 (1) state gross signal as theoretical max,
                                 (2) subtract exception floor and name top locked categories,
                                 (3) state net addressable opportunity,
                                 (4) reference realized savings as confirmed executed actions only,
                                 (5) state remaining addressable opportunity.
                                 Tone: professional consultant, matter-of-fact.

Return only the JSON object. No markdown fences, no extra keys.""")

    return '\n'.join(lines)


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('build_report triggered')
    step = 'parsing request body'

    try:
        body = req.get_json()
    except ValueError:
        return _json({'error': 'Request body must be valid JSON'}, 400)

    customer_id = (body.get('customerId') or '').strip()
    month       = body.get('month')
    year        = body.get('year')
    joel_notes  = (body.get('joelNotes') or '').strip()

    if not customer_id:
        return _json({'error': 'customerId is required'}, 400)
    if not isinstance(month, int) or not isinstance(year, int):
        return _json({'error': 'month and year must be integers'}, 400)
    if not 1 <= month <= 12:
        return _json({'error': 'month must be 1-12'}, 400)

    try:
        # ── Step 1: Validate customer ─────────────────────────────────────────
        step = 'validating customer'
        logging.info('Step 1: Validating customer %s', customer_id)
        customer = cosmos_client.get_customer(customer_id)
        if customer is None:
            return _json({'error': f'Customer {customer_id!r} not found'}, 404)
        logging.info('Step 1 done: customer=%s', customer.name)

        # ── Step 2: Fetch trend data ──────────────────────────────────────────
        step = 'fetching trend data'
        logging.info('Step 2: Fetching trend data for %d/%d', month, year)
        all_trends = cosmos_client.list_trends(customer_id)
        curr_trends = [t for t in all_trends if t.year == year and t.month == month]
        if not curr_trends:
            return _json(
                {'error': f'No trend data found for {month}/{year}. Please upload CSVs for this period first.'},
                404,
            )

        prev_month_n, prev_year = _prev_month(month, year)
        prev_trends = [t for t in all_trends if t.year == prev_year and t.month == prev_month_n]

        curr_data = {t.serviceType: t.savingsTotal for t in curr_trends}
        prev_data = {t.serviceType: t.savingsTotal for t in prev_trends}
        logging.info('Step 2 done: services=%s prev_services=%s', list(curr_data), list(prev_data))

        # ── Step 3: Fetch imported report context ─────────────────────────────
        step = 'fetching imported report context'
        logging.info('Step 3: Fetching imported report context')
        realized_savings  = 0.0
        prev_next_steps:    list = []
        ongoing_next_steps: list = []
        planned_savings:    list = []
        project_updates:    list = []
        progress_narrative: str  = ''

        try:
            all_reports   = cosmos_client.list_reports(customer_id)
            imported_curr = next(
                (r for r in all_reports
                 if r.source == 'manual_import' and r.year == year and r.month == month),
                None,
            )
            imported_prev = next(
                (r for r in all_reports
                 if r.source == 'manual_import'
                 and r.year == prev_year and r.month == prev_month_n),
                None,
            )

            if imported_curr and imported_curr.extractedData:
                realized_savings = float(imported_curr.extractedData.get('realizedSavings', 0.0))

            if imported_prev and imported_prev.extractedData:
                ed                 = imported_prev.extractedData
                prev_next_steps    = ed.get('nextSteps', []) or []
                ongoing_next_steps = ed.get('ongoingNextSteps', []) or []
                planned_savings    = ed.get('plannedSavings', []) or []
                project_updates    = ed.get('projectUpdates', []) or []
                progress_narrative = ed.get('progressNarrative', '') or ''
                if not prev_trends:
                    prev_data = ed.get('monthlySavings', {})

            logging.info(
                'Step 3 done: realized=%.2f prev_steps=%d planned=%d projects=%d ongoing=%d',
                realized_savings, len(prev_next_steps), len(planned_savings),
                len(project_updates), len(ongoing_next_steps),
            )
        except Exception as exc:
            logging.warning('Step 3: imported report lookup failed (non-fatal): %s', exc)

        # ── Step 4: Compute MoM deltas & classify ─────────────────────────────
        step = 'computing MoM deltas'
        logging.info('Step 4: Computing MoM deltas and classifications')
        top_movers_up:   list = []
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
        logging.info('Step 4 done: movers_up=%d movers_down=%d', len(top_movers_up), len(top_movers_down))

        # ── Step 5: Fetch exception summary ───────────────────────────────────
        step = 'fetching exception summary'
        logging.info('Step 5: Fetching exception summary')
        exception_summary: dict | None = None
        try:
            exception_summary = cosmos_client.exceptions_summary(customer_id)
            exc_count = exception_summary.get('totalCount', 0) if exception_summary else 0
            logging.info('Step 5 done: exception_count=%d', exc_count)
        except Exception as exc:
            logging.warning('Step 5: exception summary fetch failed (non-fatal): %s', exc)

        # ── Step 6: Call Azure OpenAI ─────────────────────────────────────────
        step = 'calling Azure OpenAI'
        logging.info('Step 6: Calling Azure OpenAI — model=%s endpoint=%s',
                     os.environ.get('AI_DEPLOYMENT_NAME', 'gpt-5.1'),
                     os.environ.get('AI_ENDPOINT', '(not set)'))

        ai_client = AzureOpenAI(
            azure_endpoint=os.environ['AI_ENDPOINT'],
            api_key=os.environ.get('AI_API_KEY', ''),
            api_version='2024-12-01-preview',
        )

        user_prompt = _build_user_prompt(
            customer_name=customer.name,
            month=month,
            year=year,
            curr_data=curr_data,
            prev_data=prev_data,
            classifications=classifications,
            top_movers_up=top_movers_up,
            top_movers_down=top_movers_down,
            joel_notes=joel_notes,
            exception_summary=exception_summary,
            prev_next_steps=prev_next_steps,
            realized_savings=realized_savings,
            planned_savings=planned_savings,
            project_updates=project_updates,
            progress_narrative=progress_narrative,
            ongoing_next_steps=ongoing_next_steps,
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
                    {'role': 'system', 'content': _SYSTEM_PROMPT},
                    {'role': 'user', 'content': user_prompt},
                ],
                response_format={'type': 'json_object'},
                temperature=0.3,
            )
            raw = completion.choices[0].message.content
            logging.info('Step 6 done: AI response length=%d chars', len(raw or ''))
            narrative = json.loads(raw)
        except Exception as exc:
            logging.error('Step 6 FAILED — AI call error: %s\n%s', exc, traceback.format_exc())
            return _json({
                'error': f'AI generation failed: {exc}',
                'step': step,
            }, 500)

        # ── Step 7: Save report to Cosmos ─────────────────────────────────────
        step = 'saving report to Cosmos'
        logging.info('Step 7: Saving report to Cosmos')
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
        logging.info('Step 7 done: report_id=%s', report_id)

    except Exception as exc:
        tb = traceback.format_exc()
        logging.error('build_report FAILED at step=%r: %s\n%s', step, exc, tb)
        return _json({
            'error': f'Failed at step "{step}": {exc}',
            'step': step,
            'traceback': tb,
        }, 500)

    exc_floor    = exception_summary['totalMonthlyCost'] if exception_summary else 0.0
    total_signal = sum(curr_data.values())

    return _json({
        'success': True,
        'reportId': report_id,
        'narrativeDraft': narrative,
        'topMoversUp': top_movers_up[:5],
        'topMoversDown': top_movers_down[:5],
        'serviceSummary': service_summary,
        'totalExceptionCost': exc_floor,
        'topExceptionCategories': (
            exception_summary.get('byCategory', [])[:5] if exception_summary else []
        ),
        'totalSignal': round(total_signal, 2),
        'realizedSavings': round(realized_savings, 2),
        'exceptionFloor': round(exc_floor, 2),
    })
