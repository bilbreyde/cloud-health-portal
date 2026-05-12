import json
import logging
import os
from datetime import datetime, timedelta, timezone

import azure.functions as func
from openai import AzureOpenAI

from shared import cosmos_client
from shared.models import Report

_CACHE_TTL_HOURS = 24
_CACHE_SRC = 'dashboard_narrative'


def _json(body, status: int = 200) -> func.HttpResponse:
    return func.HttpResponse(json.dumps(body), status_code=status, mimetype='application/json')


def _cache_id(customer_id: str) -> str:
    return f'dash-{customer_id}'


def _get_cache(customer_id: str) -> Report | None:
    try:
        cached = cosmos_client.get_report(_cache_id(customer_id), customer_id)
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


def _save_cache(customer_id: str, narrative: dict, data_snapshot: dict,
                prev_next_steps: list, commitments: dict) -> None:
    report = Report(
        id=_cache_id(customer_id),
        customerId=customer_id,
        month=0,
        year=0,
        status='cached',
        blobPath='',
        generatedAt=datetime.now(timezone.utc),
        source=_CACHE_SRC,
        narrativeDraft=json.dumps(narrative),
        extractedData={
            'dataSnapshot': data_snapshot,
            'prevNextSteps': prev_next_steps,
            'commitments': commitments,
        },
    )
    cosmos_client.update_report(report)


def main(req: func.HttpRequest) -> func.HttpResponse:
    customer_id = (req.route_params.get('customerId') or '').strip()
    if not customer_id:
        return _json({'error': 'customerId is required'}, 400)
    try:
        if req.method == 'GET':
            force = req.params.get('force', '').lower() == 'true'
            return _handle_get(customer_id, force)
        if req.method == 'PATCH':
            return _handle_patch(req, customer_id)
        return _json({'error': 'Method not allowed'}, 405)
    except Exception as exc:
        logging.exception('dashboard unhandled error')
        return _json({'error': str(exc)}, 500)


def _handle_get(customer_id: str, force: bool) -> func.HttpResponse:
    customer = cosmos_client.get_customer(customer_id)
    if customer is None:
        return _json({'error': f'Customer {customer_id!r} not found'}, 404)

    if not force:
        cached = _get_cache(customer_id)
        if cached:
            narrative = json.loads(cached.narrativeDraft or '{}')
            ext = cached.extractedData or {}
            gen_at = cached.generatedAt
            if gen_at.tzinfo is None:
                gen_at = gen_at.replace(tzinfo=timezone.utc)
            return _json({
                'narrative': narrative,
                'generatedAt': gen_at.isoformat(),
                'dataSnapshot': ext.get('dataSnapshot', {}),
                'prevNextSteps': ext.get('prevNextSteps', []),
                'commitments': ext.get('commitments', {}),
                'cached': True,
            })

    # ── Gather trend data ──────────────────────────────────────────────────────
    all_trends = cosmos_client.list_trends(customer_id)
    if not all_trends:
        return _json({'error': 'No trend data found for this customer'}, 404)

    latest_year = all_trends[0].year
    latest_month = all_trends[0].month
    curr_trends = [t for t in all_trends if t.year == latest_year and t.month == latest_month]

    prev_year = latest_year if latest_month > 1 else latest_year - 1
    prev_month = latest_month - 1 if latest_month > 1 else 12
    prev_trends = [t for t in all_trends if t.year == prev_year and t.month == prev_month]

    curr_data = {t.serviceType: t.savingsTotal for t in curr_trends}
    prev_data = {t.serviceType: t.savingsTotal for t in prev_trends}
    total_signal = sum(curr_data.values())

    # ── Exception summary ──────────────────────────────────────────────────────
    exc_summary = None
    try:
        exc_summary = cosmos_client.exceptions_summary(customer_id)
    except Exception as exc:
        logging.warning('Could not fetch exception summary: %s', exc)

    exc_floor = exc_summary['totalMonthlyCost'] if exc_summary else 0.0
    net_addressable = max(0.0, total_signal - exc_floor)

    # ── Report continuity ──────────────────────────────────────────────────────
    realized_savings:   float = 0.0
    prev_next_steps:    list  = []
    ongoing_next_steps: list  = []
    planned_savings:    list  = []
    project_updates:    list  = []
    progress_narrative: str   = ''
    prev_report_label:  str   = ''
    joel_notes:         str   = ''

    try:
        all_reports  = cosmos_client.list_reports(customer_id)
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

        if imported_curr and imported_curr.extractedData:
            realized_savings = float(imported_curr.extractedData.get('realizedSavings', 0.0))

        if imported_prev and imported_prev.extractedData:
            ed                 = imported_prev.extractedData
            prev_next_steps    = ed.get('nextSteps', []) or []
            ongoing_next_steps = ed.get('ongoingNextSteps', []) or []
            planned_savings    = ed.get('plannedSavings', []) or []
            project_updates    = ed.get('projectUpdates', []) or []
            progress_narrative = ed.get('progressNarrative', '') or ''
            try:
                prev_report_label = datetime(imported_prev.year, imported_prev.month, 1).strftime('%B %Y')
            except Exception:
                prev_report_label = f'{imported_prev.month}/{imported_prev.year}'

        if latest_generated and latest_generated.joelNotes:
            joel_notes = latest_generated.joelNotes
    except Exception as exc:
        logging.warning('Report lookup failed: %s', exc)

    remaining = max(0.0, net_addressable - realized_savings)
    data_snapshot = {
        'signal': round(total_signal, 2),
        'exceptionFloor': round(exc_floor, 2),
        'netAddressable': round(net_addressable, 2),
        'realizedSavings': round(realized_savings, 2),
        'remaining': round(remaining, 2),
        'reportingMonth': latest_month,
        'reportingYear': latest_year,
        'prevReportLabel': prev_report_label,
        'joelNotes': joel_notes,
    }

    # ── Build MoM movers for prompt ────────────────────────────────────────────
    movers_up = sorted(
        [(svc, v - prev_data.get(svc, 0.0)) for svc, v in curr_data.items()
         if v - prev_data.get(svc, 0.0) > 500],
        key=lambda x: -x[1],
    )[:3]
    movers_down = sorted(
        [(svc, v - prev_data.get(svc, 0.0)) for svc, v in curr_data.items()
         if v - prev_data.get(svc, 0.0) < -500],
        key=lambda x: x[1],
    )[:3]

    # ── Build AI prompt ────────────────────────────────────────────────────────
    month_label = datetime(latest_year, latest_month, 1).strftime('%B %Y')
    lines = [
        f"Customer: {customer.name}",
        f"Reporting Period: {month_label}",
        f"CloudHealth Savings Signal (total): ${total_signal:,.2f}",
        f"Exception Floor (business-critical servers excluded): ${exc_floor:,.2f}",
        f"Net Addressable Opportunity: ${net_addressable:,.2f}",
        f"Realized Savings (confirmed executed): ${realized_savings:,.2f}",
        f"Remaining Opportunity: ${remaining:,.2f}",
    ]
    if movers_up:
        lines.append("\nTop spending increases this month:")
        for svc, d in movers_up:
            lines.append(f"  {svc}: +${d:,.2f}")
    if movers_down:
        lines.append("\nTop cost reductions this month:")
        for svc, d in movers_down:
            lines.append(f"  {svc}: ${d:,.2f}")

    prev_label = prev_report_label or 'previous report'
    if prev_next_steps:
        lines.append(f"\nCommitments from {prev_label} (one-time items):")
        for s in prev_next_steps[:6]:
            lines.append(f"  • {s}")
    if ongoing_next_steps:
        lines.append(f"\nOngoing commitments from {prev_label}:")
        for s in ongoing_next_steps[:4]:
            lines.append(f"  • {s}")
    if planned_savings:
        lines.append("\nUpcoming planned savings pipeline (not yet in signal):")
        for s in planned_savings[:6]:
            lines.append(f"  • {s}")
    if project_updates:
        lines.append("\nActive projects / migration status:")
        for s in project_updates[:5]:
            lines.append(f"  • {s}")
    if progress_narrative:
        lines.append(f"\nPrevious report progress context:\n{progress_narrative[:800]}")
    if joel_notes:
        lines.append(f"\nEngagement manager notes (ground truth):\n{joel_notes}")

    lines.append("""
Generate a concise executive dashboard narrative. Return a JSON object with exactly these four string keys:
  "situation"      - 2-3 sentences on the current state of cloud spend and savings opportunity;
                     mention any in-flight projects or pipeline items that affect the picture
  "trend"          - 1-2 sentences summarizing month-over-month movement; explain notable increases
                     using project context where relevant (e.g. intentional upsizing)
  "exceptions"     - 1-2 sentences on the exception floor impact and net addressable opportunity
  "recommendation" - 1-2 sentences with the single most important action for this engagement right now;
                     reference the planned savings pipeline or pending project decisions if applicable

Keep each section tight and direct. Tone: confident consultant, dashboard glance — not a full report.
Return only the JSON object. No markdown fences.""")

    # ── Call OpenAI ────────────────────────────────────────────────────────────
    narrative = {'situation': '', 'trend': '', 'exceptions': '', 'recommendation': ''}
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
                    'You are a senior cloud cost optimization consultant writing concise dashboard insights. '
                    'You have access to context from the previous report cycle — commitments, projects in flight, '
                    'and the engagement manager\'s notes. This context is ground truth; weight it heavily. '
                    'Explain signal movements using project context where relevant. '
                    'Reference the planned savings pipeline and in-flight migrations by name when present.'
                )},
                {'role': 'user', 'content': '\n'.join(lines)},
            ],
            response_format={'type': 'json_object'},
            temperature=0.3,
        )
        narrative = json.loads(completion.choices[0].message.content)
    except Exception as exc:
        logging.error('OpenAI call failed: %s', exc)

    # Preserve existing commitment states across refreshes
    existing_commitments: dict = {}
    try:
        old_cache = cosmos_client.get_report(_cache_id(customer_id), customer_id)
        if old_cache and old_cache.extractedData:
            existing_commitments = old_cache.extractedData.get('commitments', {})
    except Exception:
        pass

    now_utc = datetime.now(timezone.utc)
    _save_cache(customer_id, narrative, data_snapshot, prev_next_steps, existing_commitments)

    return _json({
        'narrative': narrative,
        'generatedAt': now_utc.isoformat(),
        'dataSnapshot': data_snapshot,
        'prevNextSteps': prev_next_steps,
        'commitments': existing_commitments,
        'cached': False,
    })


def _handle_patch(req: func.HttpRequest, customer_id: str) -> func.HttpResponse:
    try:
        body = req.get_json()
    except ValueError:
        return _json({'error': 'Request body must be valid JSON'}, 400)

    commitment_key = str(body.get('commitmentKey', ''))
    checked = bool(body.get('checked', False))

    cached = cosmos_client.get_report(_cache_id(customer_id), customer_id)
    if cached is None:
        return _json({'error': 'No dashboard narrative cache found. Generate one first.'}, 404)

    ext = cached.extractedData or {}
    commitments = ext.get('commitments', {})
    commitments[commitment_key] = checked
    ext['commitments'] = commitments
    cached.extractedData = ext
    cosmos_client.update_report(cached)

    return _json({'success': True, 'commitments': commitments})
