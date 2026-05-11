import json
import logging
from collections import defaultdict
from datetime import date
from typing import Dict, List, Tuple

import azure.functions as func

from shared import cosmos_client
from shared.trend_engine import SMALL_DELTA_ABS, compute_mom_delta

MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
               'jul', 'aug', 'sep', 'oct', 'nov', 'dec']


def _json(body: dict, status: int = 200) -> func.HttpResponse:
    return func.HttpResponse(json.dumps(body), status_code=status, mimetype='application/json')


def _int_param(req: func.HttpRequest, name: str, default: int) -> int:
    raw = req.params.get(name, '').strip()
    return int(raw) if raw else default


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('run_trends triggered')
    try:
        return _handle(req)
    except Exception as exc:
        logging.exception('run_trends unhandled error')
        return _json({'error': str(exc)}, 500)


def _handle(req: func.HttpRequest) -> func.HttpResponse:
    customer_id = req.route_params.get('customerId', '').strip()
    if not customer_id:
        return _json({'error': 'customerId route parameter is required'}, 400)

    today = date.today()
    try:
        start_month = _int_param(req, 'startMonth', 1)
        start_year = _int_param(req, 'startYear', 2026)
        end_month = _int_param(req, 'endMonth', today.month)
        end_year = _int_param(req, 'endYear', today.year)
    except ValueError:
        return _json({'error': 'Date range parameters must be integers'}, 400)

    # ── Fetch & filter to requested date range ─────────────────────────────────
    all_trends = cosmos_client.list_trends(customer_id)
    trends = [
        t for t in all_trends
        if (start_year, start_month) <= (t.year, t.month) <= (end_year, end_month)
    ]

    empty = {
        'customerId': customer_id,
        'monthly_totals': [],
        'top_movers_up': [],
        'top_movers_down': [],
        'service_summary': [],
        'snapshots_detail': [],
    }
    if not trends:
        return _json(empty)

    # ── snapshots_detail: every individual snapshot, chronological ─────────────
    snapshots_detail = sorted(
        [
            {
                'serviceType': t.serviceType,
                'year': t.year,
                'month': t.month,
                'snapshotDate': t.snapshotDate,
                'snapshotNumber': t.snapshotNumber,
                'savingsTotal': t.savingsTotal,
                'rowCount': t.rowCount,
            }
            for t in trends
        ],
        key=lambda x: (x['year'], x['month'], x['snapshotDate'] or '', x['snapshotNumber']),
    )

    # ── Average snapshots within each (year, month, serviceType) ──────────────
    # Bi-weekly exports mean 2-3 snapshots per month; the monthly signal is
    # their average so MoM comparisons are consistent with the Word report.
    snapshot_groups: Dict[Tuple[int, int, str], List[float]] = defaultdict(list)
    for t in trends:
        snapshot_groups[(t.year, t.month, t.serviceType)].append(t.savingsTotal)

    by_period: Dict[Tuple[int, int], Dict[str, float]] = defaultdict(dict)
    for (yr, mo, svc), vals in snapshot_groups.items():
        by_period[(yr, mo)][svc] = round(sum(vals) / len(vals), 2)

    sorted_periods = sorted(by_period.keys())

    # ── monthly_totals ─────────────────────────────────────────────────────────
    monthly_totals = []
    for (yr, mo) in sorted_periods:
        by_svc = by_period[(yr, mo)]
        monthly_totals.append({
            'month': mo,
            'year': yr,
            'total': round(sum(by_svc.values()), 2),
            'byService': {k: round(v, 2) for k, v in sorted(by_svc.items())},
        })

    # ── Per-service chronological series (averaged monthly values) ─────────────
    all_services = sorted({svc for svc_map in by_period.values() for svc in svc_map})

    service_series: Dict[str, List[Tuple[Tuple[int, int], float]]] = {}
    for svc in all_services:
        service_series[svc] = [
            (period, by_period[period][svc])
            for period in sorted_periods
            if svc in by_period[period]
        ]

    # ── Latest MoM delta (averaged month vs averaged previous month) ───────────
    latest_deltas: Dict[str, Tuple[float, str]] = {}
    for svc, series in service_series.items():
        if len(series) >= 2:
            delta, direction = compute_mom_delta(series[-1][1], series[-2][1])
        else:
            delta, direction = 0.0, 'Flat'
        latest_deltas[svc] = (delta, direction)

    # ── top_movers_up / top_movers_down ───────────────────────────────────────
    delta_rows = [
        {'serviceType': svc, 'momDelta': round(d, 2), 'direction': dir_}
        for svc, (d, dir_) in latest_deltas.items()
    ]
    top_movers_up = sorted(
        [r for r in delta_rows if r['momDelta'] > SMALL_DELTA_ABS],
        key=lambda r: -r['momDelta'],
    )[:5]
    top_movers_down = sorted(
        [r for r in delta_rows if r['momDelta'] < -SMALL_DELTA_ABS],
        key=lambda r: r['momDelta'],
    )[:5]

    # ── service_summary (calendar view: jan–dec averages across all years) ─────
    service_summary = []
    for svc in all_services:
        series = service_series[svc]

        month_buckets: Dict[int, List[float]] = defaultdict(list)
        for (_, mo), val in series:
            month_buckets[mo].append(val)

        month_avgs = {
            name: (round(sum(month_buckets[mo_num]) / len(month_buckets[mo_num]), 2)
                   if month_buckets[mo_num] else None)
            for mo_num, name in enumerate(MONTH_NAMES, start=1)
        }

        delta, direction = latest_deltas[svc]
        service_summary.append({
            'serviceType': svc,
            **month_avgs,
            'momDelta': round(delta, 2),
            'direction': direction,
        })

    return _json({
        'customerId': customer_id,
        'monthly_totals': monthly_totals,
        'top_movers_up': top_movers_up,
        'top_movers_down': top_movers_down,
        'service_summary': service_summary,
        'snapshots_detail': snapshots_detail,
    })
