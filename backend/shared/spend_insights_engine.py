"""Pure analytical calculations for the AI spend-insights feature.

No Cosmos / HTTP / OpenAI dependencies here — everything takes already-fetched
data in and returns plain dicts, so both the spend_insights function and
export_report can share one implementation (mirrors shared/trend_engine.py).
"""
import calendar
import statistics
from datetime import date
from typing import Optional

from .cost_classifier import classify_service, compute_edp_utilization
from .cost_classifier import priority_rank as classifier_priority_rank
from .cost_classifier import project_amount as classify_project_amount

# CloudHealth tracks signal at this coarse a granularity (see trend_engine._SERVICE_MAP).
# cost_history service names are far more granular ("EC2 - Compute", "EC2 - Transfer", …);
# the prefix before " - " maps back up to one of these when correlating spend to signal.
TREND_CATEGORIES = {'EC2', 'RDS', 'EBS', 'S3', 'ElastiCache', 'Redshift', 'OpenSearch', 'DynamoDB'}

SP_TARGET_PCT = 70.0
_TREND_FLAT_PCT = 3.0  # |% change| at or below this reads as "flat"


def _fmt(n: float) -> str:
    return f'${n:,.2f}'


def is_partial_month(month_str: str, today: Optional[date] = None) -> tuple:
    """(is_partial, completion_ratio) — e.g. Jul 23 of 31 days -> (True, 0.7419...).

    Only the real, still-in-progress calendar month is ever partial; a past month
    is always (False, 1.0) even if it happens to have sparse/incomplete billing
    data — "partial" here means calendar-partial, not data-partial.
    """
    today = today or date.today()
    year, month = int(month_str[:4]), int(month_str[5:7])
    if year == today.year and month == today.month:
        days_in_month = calendar.monthrange(year, month)[1]
        return True, today.day / days_in_month
    return False, 1.0


def project_amount(amount: float, completion_ratio: float) -> float:
    """Scale a partial-month amount up to a full-month run-rate estimate."""
    if completion_ratio <= 0:
        return amount
    return amount / completion_ratio


def month_day_counts(month_str: str, today: Optional[date] = None) -> tuple:
    """(days_elapsed, days_in_month) — for a past month, days_elapsed == days_in_month."""
    today = today or date.today()
    year, month = int(month_str[:4]), int(month_str[5:7])
    days_in_month = calendar.monthrange(year, month)[1]
    if year == today.year and month == today.month:
        return today.day, days_in_month
    return days_in_month, days_in_month


def last_n_months(end_month: str, n: int) -> list:
    """['2027-02', ..., '2027-07'] for end_month='2027-07', n=6 — oldest first."""
    year, month = (int(x) for x in end_month.split('-'))
    months = []
    for _ in range(n):
        months.append(f'{year:04d}-{month:02d}')
        month -= 1
        if month == 0:
            month = 12
            year -= 1
    return list(reversed(months))


def service_category(service_name: str) -> Optional[str]:
    prefix = service_name.split(' - ')[0].strip()
    return prefix if prefix in TREND_CATEGORIES else None


def priority_for(estimated_savings: float) -> str:
    if estimated_savings >= 10000:
        return 'High'
    if estimated_savings >= 2000:
        return 'Medium'
    return 'Low'


# ── anomaly detection ──────────────────────────────────────────────────────────

def _build_anomaly(
    service: str, current: float, rolling_avg: Optional[float], variance: Optional[float],
    anomaly_type: str, classification: dict, is_projected: bool, explanation: str,
) -> dict:
    return {
        'service': service,
        'currentAmount': round(current, 2),
        'rollingAvg': round(rolling_avg, 2) if rolling_avg is not None else 0.0,
        'variance': round(variance, 2) if variance is not None else None,
        'type': anomaly_type,
        'isProjected': is_projected,
        'flagType': classification.get('flag_type', ''),
        'color': classification.get('color', 'gray'),
        'pattern': classification.get('pattern', 'recurring'),
        'optimizationAction': classification.get('optimization_action'),
        'explanation': explanation,
    }


def compute_anomalies(
    by_service: list,
    months_in_window: list,
    is_partial: bool = False,
    completion_ratio: float = 1.0,
) -> list:
    """One entry per flagged service: commitment_risk > new_service > statistical_anomaly > spike.

    Every service is classified first (shared.cost_classifier): a one-time/excluded
    charge (Amazon Marketplace, Enterprise Support, …) is never projected — a one-time
    $1.2M software purchase doesn't become $1.6M just because 74% of the month has
    elapsed — while a recurring charge is projected before comparison, same as before.
    "alert_if_growing" services (unused Savings Plan capacity) are flagged the instant
    they're non-zero, bypassing the statistical checks entirely — any unused committed
    capacity is worth surfacing immediately, not just when it's statistically unusual.
    """
    if len(months_in_window) < 2:
        return []

    current_month = months_in_window[-1]
    prior_months = months_in_window[:-1]
    anomalies = []

    for svc in by_service:
        service = svc['service']
        classification = classify_service(service)
        month_vals = svc.get('months', {})
        current_raw = month_vals.get(current_month, 0.0)
        prior_vals = [month_vals.get(m, 0.0) for m in prior_months]

        if classification.get('alert_if_growing') and current_raw > 0:
            anomalies.append(_build_anomaly(
                service, current_raw, 0.0, None, 'commitment_risk', classification, False,
                explanation=f'{service} shows {_fmt(current_raw)} this month — {classification["description"]}',
            ))
            continue

        current, was_projected = (
            classify_project_amount(current_raw, service, completion_ratio) if is_partial
            else (current_raw, False)
        )
        tag = ' (projected)' if was_projected else ''

        if current <= 0:
            continue

        if prior_vals and all(v == 0 for v in prior_vals):
            anomalies.append(_build_anomaly(
                service, current, 0.0, None, 'new_service', classification, was_projected,
                explanation=(
                    f'{service} had no recorded spend in the prior {len(prior_vals)} '
                    f'month(s) but shows {_fmt(current)}{tag} this month.'
                ),
            ))
            continue

        rolling_window = prior_vals[-3:] if len(prior_vals) >= 3 else prior_vals
        if len(rolling_window) >= 2:
            avg = statistics.mean(rolling_window)
            stdev = statistics.stdev(rolling_window)
            threshold = avg + 2 * stdev
            if stdev > 0 and current > threshold:
                anomalies.append(_build_anomaly(
                    service, current, avg, stdev, 'statistical_anomaly', classification, was_projected,
                    explanation=(
                        f'{service} is {_fmt(current)}{tag} this month, above its rolling average of '
                        f'{_fmt(avg)} plus two standard deviations ({_fmt(threshold)}).'
                    ),
                ))
                continue

        prev = prior_vals[-1] if prior_vals else 0.0
        if prev > 0:
            mom_pct = (current - prev) / prev * 100
            if mom_pct > 50:
                anomalies.append(_build_anomaly(
                    service, current, prev, mom_pct, 'spike', classification, was_projected,
                    explanation=(
                        f'{service} rose {mom_pct:.0f}% month-over-month, '
                        f'from {_fmt(prev)} to {_fmt(current)}{tag}.'
                    ),
                ))

    anomalies.sort(key=lambda a: -a['currentAmount'])
    return anomalies


# ── savings plan coverage ──────────────────────────────────────────────────────

def compute_coverage_analysis(
    savings_plan_coverage: dict,
    by_service: list,
    months_in_window: list,
    is_partial: bool = False,
    completion_ratio: float = 1.0,
) -> dict:
    current_pct = savings_plan_coverage.get('coveragePct', 0.0)
    covered = savings_plan_coverage.get('covered', 0.0)
    on_demand = savings_plan_coverage.get('onDemand', 0.0)
    total_ec2_compute = covered + on_demand

    # Rough approximation, not a quote: ~30% of remaining on-demand spend would realistically
    # convert to committed usage, at an ~40% Savings Plan discount rate.
    estimated_savings = round((on_demand * 0.30) * 0.40, 2)
    gap_pct_points = max(0.0, SP_TARGET_PCT - current_pct)
    gap_amount = round(total_ec2_compute * gap_pct_points / 100, 2)

    # Project the current month's contribution before it enters the variance calc — a
    # partial month is naturally lower than a full one and would otherwise read as
    # volatility that isn't really there, skewing the term recommendation toward 1-Year.
    current_month = months_in_window[-1] if months_in_window else None
    ec2_compute = next((s for s in by_service if s['service'].strip().lower() == 'ec2 - compute'), None)
    ec2_vals = []
    if ec2_compute:
        for m in months_in_window:
            v = ec2_compute['months'].get(m, 0.0)
            if is_partial and m == current_month:
                v = project_amount(v, completion_ratio)
            ec2_vals.append(v)
    ec2_vals = [v for v in ec2_vals if v > 0]

    if len(ec2_vals) >= 2 and statistics.mean(ec2_vals) > 0:
        cv = statistics.stdev(ec2_vals) / statistics.mean(ec2_vals)
        term = '3-Year' if cv < 0.10 else '1-Year'
        stability = 'stable, predictable' if term == '3-Year' else 'more variable'
        upside = (
            'locks in the deeper discount with low risk of over-committing' if term == '3-Year'
            else 'keeps flexibility while coverage grows and usage patterns settle'
        )
        rationale = (
            f'EC2 compute spend has varied by {cv * 100:.1f}% (coefficient of variation) over the last '
            f'{len(ec2_vals)} months, indicating {stability} usage — a {term} commitment {upside}.'
        )
    else:
        term = None
        rationale = 'Not enough monthly EC2 compute history yet to recommend a commitment term confidently.'

    return {
        'currentPct': round(current_pct, 1),
        'targetPct': SP_TARGET_PCT,
        'gapAmount': gap_amount,
        'estimatedSavings': estimated_savings,
        'recommendation': {'term': term, 'rationale': rationale},
    }


# ── signal vs spend correlation ────────────────────────────────────────────────

def _trend_label(delta: float, prev: float) -> str:
    if prev == 0:
        if delta > 0:
            return 'up'
        return 'down' if delta < 0 else 'flat'
    pct = delta / abs(prev) * 100
    if pct > _TREND_FLAT_PCT:
        return 'up'
    if pct < -_TREND_FLAT_PCT:
        return 'down'
    return 'flat'


def _interpret(spend_trend: str, signal_trend: str) -> tuple:
    """Returns (interpretation, status) per the four documented rules, plus a fallback."""
    if spend_trend == 'down' and signal_trend == 'flat':
        return 'Optimization executing, signal lag expected', 'executing'
    if spend_trend == 'up' and signal_trend == 'up':
        return 'Organic growth — verify against project pipeline', 'growing'
    if spend_trend == 'up' and signal_trend == 'down':
        return 'Alert — spend growing but signal shrinking, review exception classifications', 'alert'
    if spend_trend == 'flat' and signal_trend == 'flat':
        return 'Stable — no action needed', 'stable'
    return f'Spend {spend_trend}, signal {signal_trend} — monitor', 'monitor'


def compute_correlations(
    by_service: list,
    trend_records: list,
    months_in_window: list,
    is_partial: bool = False,
    completion_ratio: float = 1.0,
) -> list:
    """trend_records: list of {serviceType, month (int), year (int), savingsTotal}.

    Only the spend side is projected when the current month is partial — CloudHealth
    signal comes from a monthly CSV snapshot, not a continuous daily billing feed, so
    it doesn't have the same intra-month completeness issue.
    """
    if len(months_in_window) < 2:
        return []

    current_month = months_in_window[-1]
    prior_month = months_in_window[-2]

    spend_by_cat_month: dict = {}
    for svc in by_service:
        cat = service_category(svc['service'])
        if not cat:
            continue
        spend_by_cat_month.setdefault(cat, {})
        for m, v in svc.get('months', {}).items():
            spend_by_cat_month[cat][m] = spend_by_cat_month[cat].get(m, 0.0) + v

    signal_by_cat_month: dict = {}
    for t in trend_records:
        m_key = f"{t['year']:04d}-{t['month']:02d}"
        if m_key not in months_in_window:
            continue
        cat = t['serviceType']
        signal_by_cat_month.setdefault(cat, {})
        signal_by_cat_month[cat][m_key] = signal_by_cat_month[cat].get(m_key, 0.0) + t['savingsTotal']

    correlations = []
    for cat in sorted(set(spend_by_cat_month) | set(signal_by_cat_month)):
        spend_curr_raw = spend_by_cat_month.get(cat, {}).get(current_month, 0.0)
        spend_curr = project_amount(spend_curr_raw, completion_ratio) if is_partial else spend_curr_raw
        spend_prev = spend_by_cat_month.get(cat, {}).get(prior_month, 0.0)
        signal_curr = signal_by_cat_month.get(cat, {}).get(current_month, 0.0)
        signal_prev = signal_by_cat_month.get(cat, {}).get(prior_month, 0.0)

        spend_trend = _trend_label(spend_curr - spend_prev, spend_prev)
        signal_trend = _trend_label(signal_curr - signal_prev, signal_prev)
        interpretation, status = _interpret(spend_trend, signal_trend)

        correlations.append({
            'service': cat,
            'spendTrend': spend_trend,
            'signalTrend': signal_trend,
            'interpretation': interpretation,
            'status': status,
        })

    return correlations


# ── additional optimization opportunities ──────────────────────────────────────

def _svc_val(by_service: list, name: str, month: str) -> float:
    svc = next((s for s in by_service if s['service'].strip().lower() == name.strip().lower()), None)
    return svc['months'].get(month, 0.0) if svc else 0.0


_EDP_RISK_RATIO = 0.85  # trailing 3-mo recurring avg below this fraction of obligation -> risk flag


def compute_opportunities(
    by_service: list,
    coverage_analysis: Optional[dict],
    current_month: str,
    months_in_window: Optional[list] = None,
    monthly_obligation: Optional[float] = None,
    skip_savings_plan_opportunity: bool = False,
    is_partial: bool = False,
    completion_ratio: float = 1.0,
) -> list:
    """Threshold-based optimization opportunities, sorted Critical > High > Medium > Low,
    then by estimated savings within each priority tier.

    coverage_analysis may be None when the customer has a commitment context instead —
    the generic Savings Plan gap opportunity doesn't apply there (skip_savings_plan_opportunity
    should be True); monthly_obligation + months_in_window drive the EDP-specific checks
    (unused SP capacity, burn-rate risk) instead.

    Dollar figures are classification-aware projections when the current month is
    partial — a one-time charge (e.g. Rekognition trial) is never scaled up, a
    recurring one (EC2 Transfer, EBS Snapshot, …) is, same rule as anomaly detection.
    """
    def val(name: str) -> float:
        raw = _svc_val(by_service, name, current_month)
        if is_partial:
            projected, _ = classify_project_amount(raw, name, completion_ratio)
            return projected
        return raw

    opportunities = []

    if not skip_savings_plan_opportunity and coverage_analysis and coverage_analysis['currentPct'] < SP_TARGET_PCT:
        est = coverage_analysis['estimatedSavings']
        opportunities.append({
            'category': 'Savings Plan',
            'service': 'EC2 Compute',
            'currentCost': round(coverage_analysis['gapAmount'], 2),
            'estimatedSavings': est,
            'priority': priority_for(est),
            'action': (
                f"Increase Savings Plan coverage from {coverage_analysis['currentPct']:.1f}% "
                f'toward the {coverage_analysis["targetPct"]:.0f}% target.'
            ),
        })

    # a. EC2 data transfer (incl. NAT Gateway) vs. EC2 Compute
    ec2_compute = val('EC2 - Compute')
    ec2_transfer = val('EC2 - Transfer') + val('EC2 - NAT Gateway Transfer')
    if ec2_compute > 0 and ec2_transfer > ec2_compute * 0.03:
        est = round(ec2_transfer * 0.60, 2)
        opportunities.append({
            'category': 'Networking', 'service': 'EC2 - Transfer',
            'currentCost': round(ec2_transfer, 2), 'estimatedSavings': est, 'priority': priority_for(est),
            'action': 'VPC Endpoint review — eliminates NAT Gateway data transfer charges',
        })

    # b. EBS snapshot vs. EBS storage
    ebs_storage = val('EBS - Storage')
    ebs_snapshot = val('EC2 - EBS Snapshot')
    if ebs_storage > 0 and ebs_snapshot > ebs_storage * 0.15:
        est = round(ebs_snapshot * 0.50, 2)
        opportunities.append({
            'category': 'Storage', 'service': 'EC2 - EBS Snapshot',
            'currentCost': round(ebs_snapshot, 2), 'estimatedSavings': est, 'priority': priority_for(est),
            'action': 'EBS snapshot lifecycle policy review — delete snapshots older than retention policy',
        })

    # c. RDS backup vs. RDS compute
    rds_compute = val('RDS - Compute')
    rds_backup = val('RDS - Charged Backup Usage')
    if rds_compute > 0 and rds_backup > rds_compute * 0.20:
        est = round(rds_backup * 0.40, 2)
        opportunities.append({
            'category': 'Database', 'service': 'RDS - Charged Backup Usage',
            'currentCost': round(rds_backup, 2), 'estimatedSavings': est, 'priority': priority_for(est),
            'action': 'Review RDS backup retention periods — reduce non-production to 7 days',
        })

    # d. WorkSpaces absolute threshold
    workspaces = val('Amazon WorkSpaces')
    if workspaces > 5000:
        est = round(workspaces * 0.25, 2)
        opportunities.append({
            'category': 'Compute', 'service': 'WorkSpaces',
            'currentCost': round(workspaces, 2), 'estimatedSavings': est, 'priority': priority_for(est),
            'action': 'WorkSpaces right-sizing — match bundle size to actual usage patterns',
        })

    # e. Unknown-workload service — always flag if present, regardless of amount
    rekognition = val('Amazon Rekognition')
    if rekognition > 0:
        opportunities.append({
            'category': 'Unknown Workload', 'service': 'Amazon Rekognition',
            'currentCost': round(rekognition, 2), 'estimatedSavings': 0.0, 'priority': 'Low',
            'action': 'Identify Rekognition use case owner — confirm intentional usage',
        })

    # f. Multi-AZ architecture review — always flag if present
    multi_az = val('RDS - Multi-AZ GP3 Storage')
    if multi_az > 0:
        est = round(multi_az * 0.30, 2)
        opportunities.append({
            'category': 'Architecture', 'service': 'RDS - Multi-AZ GP3 Storage',
            'currentCost': round(multi_az, 2), 'estimatedSavings': est, 'priority': priority_for(est),
            'action': 'Audit Multi-AZ RDS instances — disable for dev/test environments',
        })

    # g. Unused Savings Plan capacity — double-waste risk on top of a commitment
    sp_unused = val('Savings Plan - Unused') + val('Database Savings Plan - Unused')
    if sp_unused > 0:
        opportunities.append({
            'category': 'Savings Plan', 'service': 'Unused Savings Plan Capacity',
            'currentCost': round(sp_unused, 2), 'estimatedSavings': 0.0, 'priority': 'High',
            'action': (
                'Migrate workloads to consume committed SP capacity — '
                'unused SP on top of EDP is double-waste'
            ),
        })

    # EDP burn-rate risk — trailing 3-month RECURRING average vs. 85% of obligation.
    # Only recurring-classified services enter the average, so a month dominated by a
    # one-time charge (or lacking one) doesn't distort whether the commitment itself
    # is being consumed.
    if monthly_obligation and months_in_window:
        trailing_months = months_in_window[-3:]
        trailing_vals = []
        for m in trailing_months:
            month_recurring = sum(
                s['months'].get(m, 0.0) for s in by_service
                if classify_service(s['service'])['pattern'] == 'recurring'
            )
            if is_partial and m == current_month:
                month_recurring = project_amount(month_recurring, completion_ratio)
            trailing_vals.append(month_recurring)
        trailing_avg = statistics.mean(trailing_vals) if trailing_vals else 0.0
        threshold_85 = monthly_obligation * _EDP_RISK_RATIO
        if trailing_avg < threshold_85:
            opportunities.append({
                'category': 'EDP Risk', 'service': 'EDP Under-Utilization Risk',
                'currentCost': round(trailing_avg, 2), 'estimatedSavings': 0.0, 'priority': 'Critical',
                'action': (
                    f'Trailing 3-month recurring spend ({_fmt(trailing_avg)}) is below 85% of EDP obligation '
                    f'({_fmt(threshold_85)}). Risk of unfavorable renewal terms. Identify workloads to migrate '
                    f'to AWS to consume committed capacity.'
                ),
            })

    opportunities.sort(key=lambda o: (classifier_priority_rank(o['priority']), -o['estimatedSavings']))
    return opportunities


def current_day_of_month(today: Optional[date] = None) -> int:
    return (today or date.today()).day


# ── large-commitment (EDP / Enterprise Agreement) utilization ─────────────────

def months_between(end_date_str: str, as_of_month: str) -> int:
    """Whole months from as_of_month (YYYY-MM) to end_date_str (YYYY-MM-DD).
    Negative if the end date is already in the past relative to as_of_month."""
    end_year, end_month_n = (int(x) for x in end_date_str.split('-')[:2])
    as_of_year, as_of_month_n = (int(x) for x in as_of_month.split('-'))
    return (end_year - as_of_year) * 12 + (end_month_n - as_of_month_n)


def compute_commitment_utilization(
    commitment: dict,
    monthly_totals: list,
    months_in_window: list,
    by_service: list,
    is_partial: bool = False,
    completion_ratio: float = 1.0,
) -> dict:
    """monthly_totals: cost_summary['monthlyTotals'] shape — [{month, netCost, ...}, ...].
    by_service: cost_summary['byService'] shape — [{service, months: {month: amount}}, ...].

    Utilization compares the obligation against RECURRING spend only (shared.cost_classifier)
    — a one-time software purchase (Amazon Marketplace) or a flat fee (Enterprise Support)
    doesn't represent capacity consumed against the commitment, and including it made a
    normal month look wildly over-utilized. actualSpend (all patterns, to-date) is kept
    alongside for "what's billed so far" display; it never drives the utilization math.
    """
    monthly_obligation = commitment.get('commitmentMonthlyObligation')
    if not monthly_obligation:
        annual = commitment.get('commitmentAnnualValue') or 0.0
        monthly_obligation = annual / 12 if annual else 0.0

    current_month = months_in_window[-1]

    services_data = []
    for svc in by_service:
        if current_month not in svc.get('months', {}):
            continue
        raw = svc['months'][current_month]
        if is_partial:
            projected, _ = classify_project_amount(raw, svc['service'], completion_ratio)
        else:
            projected = raw
        services_data.append({'service': svc['service'], 'amount': raw, 'projected_amount': projected})

    edp = compute_edp_utilization(services_data, monthly_obligation)
    actual_spend_to_date = sum(s['amount'] for s in services_data)
    net_billed = edp['recurring_spend'] + edp['one_time_charges'] - edp['credits']

    # Trailing 3-month RECURRING average (not raw netCost) drives the burn-rate risk
    # flag, matching the EDP Under-Utilization Risk opportunity's own threshold.
    trailing_months = months_in_window[-3:]
    trailing_vals = []
    for m in trailing_months:
        month_recurring = sum(
            s['months'].get(m, 0.0) for s in by_service
            if classify_service(s['service'])['pattern'] == 'recurring'
        )
        if is_partial and m == current_month:
            month_recurring = project_amount(month_recurring, completion_ratio)
        trailing_vals.append(month_recurring)
    trailing_3mo_avg = round(statistics.mean(trailing_vals), 2) if trailing_vals else None
    under_utilization_risk = bool(
        trailing_3mo_avg is not None and monthly_obligation
        and trailing_3mo_avg < monthly_obligation * _EDP_RISK_RATIO
    )

    end_date = commitment.get('commitmentEndDate')
    months_remaining = months_between(end_date, current_month) if end_date else None
    expiry_warning = months_remaining is not None and months_remaining < 6

    return {
        'commitmentType': commitment.get('commitmentType'),
        'monthlyObligation': round(monthly_obligation, 2),
        'actualSpend': round(actual_spend_to_date, 2),
        'projectedSpend': round(net_billed, 2),
        'isPartial': is_partial,
        'completionRatio': round(completion_ratio, 4),
        'recurringSpend': round(edp['recurring_spend'], 2),
        'oneTimeCharges': round(edp['one_time_charges'], 2),
        'credits': round(edp['credits'], 2),
        'netBilled': round(net_billed, 2),
        'excludedServices': edp['excluded_services'],
        'utilizationPct': round(edp['utilization_pct'], 1),
        'onTrack': edp['on_track'],
        'overUnderAmount': round(edp['recurring_spend'] - monthly_obligation, 2) if monthly_obligation else None,
        'trailing3MoAvg': trailing_3mo_avg,
        'underUtilizationRisk': under_utilization_risk,
        'monthsRemaining': months_remaining,
        'expiryWarning': expiry_warning,
        'commitmentEndDate': end_date,
        'commitmentAnnualValue': commitment.get('commitmentAnnualValue'),
        'commitmentTermYears': commitment.get('commitmentTermYears'),
        'discountRate': commitment.get('discountRate'),
    }
