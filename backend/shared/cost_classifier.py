"""Charge classification for cost_history / spend_insights.

Standalone, zero-dependency module (like spend_insights_engine.py) — classifies
a service name into a charge pattern (recurring / one-time / credit) and, for a
known set of services, attaches rich anomaly metadata (flag type, color,
optimization action). Used to decide what gets projected to a full month and
what gets excluded from EDP/commitment utilization math.
"""
from typing import Optional

# Reference lists of service-name substrings per pattern. ANOMALY_RULES (below) is
# checked first since it carries richer metadata; these lists are the fallback for
# every other named service that keyword-guessing alone wouldn't catch (e.g. "AWS
# Config" has no "fee"/"license"/etc. keyword in it, but is unambiguously one-time).
ONE_TIME_SERVICES = [
    "Amazon Marketplace",
    "AWS Marketplace",
    "AWS Partner Pricing Adjustment",
    "AWS Config",
    "AWS CloudTrail",
    "Amazon Inspector",
    "Certificate Manager",
    "Augmented AI",
    "AWS Support",
    "Savings Plan - Unused",
    "Database Savings Plan - Unused",
    "Compute Savings Plan - Unused",
]

CREDIT_SERVICES = [
    "Savings Plan Negation",
    "Savings Plan - Negation",
    "EC2 - Savings Plan Negation Credits",
    "RDS - Database Savings Plan Negation Credits",
    "Reserved Instance",
    "RI Volume Discount",
    "AWS Partner Pricing Adjustment",  # can be negative
]

RECURRING_SERVICES = [
    "Enterprise Support",
    "EC2 - Compute",
    "RDS - Compute",
    "RDS - Database",
    "EBS - Storage",
    "EBS - PIOPs Storage",
    "S3 - Storage",
    "S3 - Standard",
    "S3 - Standard Infrequent Access",
    "S3 - Glacier",
    "ElastiCache",
    "OpenSearch",
    "Redshift",
    "CloudWatch",
    "EC2 - Transfer",
    "EC2 - NAT Gateway Transfer",
    "Virtual Private Cloud",
    "WorkSpaces",
    "Amazon WorkSpaces",
    "RDS - Storage",
    "RDS - I/O",
    "RDS - Data Transfer",
    "Storage Gateway",
    "Amazon DynamoDB",
    "AWS Lambda",
    "Amazon ECS",
    "Amazon EKS",
]

# color is one of: blue | yellow | orange | red | purple | gray | green
ANOMALY_RULES = {
    "Amazon Marketplace": {
        "pattern": "one_time",
        "flag_type": "Notable One-Time Charge",
        "color": "blue",
        "description": "Software license or SaaS marketplace purchase. Not extrapolated.",
        "exclude_from_edp": True,
        "exclude_from_projection": True,
    },
    "AWS Partner Pricing Adjustment": {
        "pattern": "variable_adjustment",
        "flag_type": "Variable Adjustment",
        "color": "gray",
        "description": "AWS billing adjustment that scales with total monthly spend, not a flat one-time correction.",
        "exclude_from_edp": False,
        "exclude_from_projection": False,
    },
    "Enterprise Support": {
        "pattern": "support_fee",
        "flag_type": "Support Fee",
        "color": "purple",
        "description": "AWS Enterprise Support — accrues monthly as a percentage of total AWS spend (with a contractual minimum), not a flat fee. Recurring, but not infrastructure.",
        "exclude_from_edp": False,
        "exclude_from_projection": False,
    },
    "Savings Plan - Unused": {
        "pattern": "one_time",
        "flag_type": "Unused Commitment",
        "color": "red",
        "description": "Indicates purchased Savings Plan capacity is not being consumed. Double-waste risk on EDP.",
        "exclude_from_edp": False,
        "exclude_from_projection": True,
        "alert_if_growing": True,
    },
    "Database Savings Plan - Unused": {
        "pattern": "one_time",
        "flag_type": "Unused Commitment",
        "color": "red",
        "description": "RDS Savings Plan capacity going unused.",
        "exclude_from_edp": False,
        "exclude_from_projection": True,
        "alert_if_growing": True,
    },
    "EC2 - Transfer": {
        "pattern": "recurring",
        "flag_type": "Data Transfer",
        "color": "yellow",
        "threshold_pct_of_ec2": 0.03,
        "description": "If > 3% of EC2 Compute spend, review VPC endpoint configuration.",
        "optimization_action": "VPC Endpoint review — eliminates NAT Gateway data transfer charges",
    },
    "EC2 - NAT Gateway Transfer": {
        "pattern": "recurring",
        "flag_type": "Data Transfer",
        "color": "yellow",
        "threshold_pct_of_ec2": 0.03,
        "description": "NAT Gateway transfer charges. VPC endpoints can eliminate these for AWS service traffic.",
        "optimization_action": "VPC Endpoint review",
    },
    "EC2 - EBS Snapshot": {
        "pattern": "recurring",
        "flag_type": "Storage Hygiene",
        "color": "yellow",
        "threshold_pct_of_ebs": 0.15,
        "description": "If > 15% of EBS Storage spend, stale snapshots likely accumulating.",
        "optimization_action": "EBS snapshot lifecycle policy review — delete snapshots older than retention policy",
    },
    "RDS - Charged Backup Usage": {
        "pattern": "recurring",
        "flag_type": "Storage Hygiene",
        "color": "yellow",
        "threshold_pct_of_rds": 0.20,
        "description": "If > 20% of RDS Compute spend, backup retention period may be excessive.",
        "optimization_action": "Review RDS backup retention periods — reduce non-production to 7 days",
    },
    "RDS - Multi-AZ GP3 Storage": {
        "pattern": "recurring",
        "flag_type": "Architecture Review",
        "color": "purple",
        "description": "Multi-AZ doubles storage cost. Confirm all Multi-AZ RDS instances are production-critical.",
        "optimization_action": "Audit Multi-AZ RDS instances — disable for dev/test environments",
    },
    "WorkSpaces Applications - Fleet Instance": {
        "pattern": "recurring",
        "flag_type": "Seat Expansion",
        "color": "yellow",
        "description": "WorkSpaces thin client seat growth. Correlate against headcount.",
        "optimization_action": "Review WorkSpaces utilization — decommission unused seats",
    },
    "Amazon Rekognition": {
        "pattern": "recurring",
        "flag_type": "Unknown Workload",
        "color": "yellow",
        "description": "AI image recognition service — unusual for infrastructure companies. Verify known use case.",
        "optimization_action": "Identify Rekognition use case owner — confirm intentional usage",
    },
    "Amazon WorkSpaces": {
        "pattern": "recurring",
        "flag_type": "Right-Sizing Opportunity",
        "color": "yellow",
        "threshold_monthly": 5000,
        "description": "If > $5K/month, WorkSpaces right-sizing assessment warranted.",
        "optimization_action": "WorkSpaces right-sizing — match bundle size to actual usage patterns",
    },
}

_CREDIT_KEYWORDS = ["negation", "credit", "refund", "discount", "adjustment"]
_ONE_TIME_KEYWORDS = [
    "fee", "license", "contract", "unused", "support",
    "marketplace", "flat", "annual", "subscription",
]


def _matches_any(service_lower: str, names: list) -> bool:
    return any(name.lower() in service_lower for name in names)


def classify_service(service_name: str) -> dict:
    """
    Returns classification dict:
    {
        pattern: "one_time" | "recurring" | "credit" | "mixed",
        flag_type: str,
        color: "blue" | "yellow" | "orange" | "red" | "purple" | "gray" | "green",
        exclude_from_edp: bool,
        exclude_from_projection: bool,
        optimization_action: str | None,
        alert_if_growing: bool,
        description: str
    }
    """
    service_lower = service_name.lower()

    # Check exact/known-rule matches first — richest metadata.
    for key, rules in ANOMALY_RULES.items():
        if key.lower() in service_lower:
            result = {
                'flag_type': rules.get('flag_type', ''),
                'color': rules.get('color', 'gray'),
                'exclude_from_edp': rules.get('exclude_from_edp', False),
                'exclude_from_projection': rules.get('exclude_from_projection', False),
                'optimization_action': rules.get('optimization_action'),
                'alert_if_growing': rules.get('alert_if_growing', False),
                'description': rules.get('description', ''),
                'pattern': rules.get('pattern', 'recurring'),
            }
            result['matched_rule'] = key
            return result

    # Named credit services (list-driven — catches names keyword-guessing would miss,
    # e.g. "Reserved Instance" has no "negation"/"credit"/etc. substring).
    if _matches_any(service_lower, CREDIT_SERVICES):
        return {
            'pattern': 'credit',
            'flag_type': 'Credit/Adjustment',
            'color': 'green',
            'exclude_from_edp': True,
            'exclude_from_projection': True,
            'alert_if_growing': False,
            'description': 'Billing credit or adjustment — reduces net spend.',
            'optimization_action': None,
        }

    # Credit keyword fallback.
    if any(k in service_lower for k in _CREDIT_KEYWORDS):
        return {
            'pattern': 'credit',
            'flag_type': 'Credit/Adjustment',
            'color': 'green',
            'exclude_from_edp': True,
            'exclude_from_projection': True,
            'alert_if_growing': False,
            'description': 'Billing credit or adjustment — reduces net spend.',
            'optimization_action': None,
        }

    # Named one-time services (list-driven — catches "AWS Config", "Certificate
    # Manager", etc. that no generic keyword below would match).
    if _matches_any(service_lower, ONE_TIME_SERVICES):
        return {
            'pattern': 'one_time',
            'flag_type': 'One-Time / Flat Fee',
            'color': 'blue',
            'exclude_from_edp': True,
            'exclude_from_projection': True,
            'alert_if_growing': False,
            'description': 'One-time or flat-fee charge. Not extrapolated for projection.',
            'optimization_action': None,
        }

    # One-time keyword fallback.
    if any(k in service_lower for k in _ONE_TIME_KEYWORDS):
        return {
            'pattern': 'one_time',
            'flag_type': 'One-Time / Flat Fee',
            'color': 'blue',
            'exclude_from_edp': True,
            'exclude_from_projection': True,
            'alert_if_growing': False,
            'description': 'One-time or flat-fee charge. Not extrapolated for projection.',
            'optimization_action': None,
        }

    # Default to recurring (also matches RECURRING_SERVICES, which is documentation
    # of the common case rather than a gate — nothing else claimed this service).
    return {
        'pattern': 'recurring',
        'flag_type': 'Recurring Compute/Storage',
        'color': 'gray',
        'exclude_from_edp': False,
        'exclude_from_projection': False,
        'alert_if_growing': False,
        'description': 'Recurring usage-based charge.',
        'optimization_action': None,
    }


def project_amount(actual: float, service_name: str, completion_ratio: float) -> tuple:
    """
    Returns (projected_amount, was_projected).
    One-time / excluded charges return actual unchanged — a one-time $1.2M software
    purchase doesn't become $1.6M just because 74% of the month has elapsed.
    Recurring charges return actual / completion_ratio.
    """
    classification = classify_service(service_name)
    if classification['exclude_from_projection']:
        return actual, False
    if completion_ratio <= 0:
        return actual, False
    return actual / completion_ratio, True


def compute_edp_utilization(services_data: list, monthly_obligation: float, is_partial: bool = False) -> dict:
    """
    EDP utilization = all billed spend minus AWS-applied credits. Marketplace,
    Enterprise Support, Partner Pricing Adjustment, AWS Config/CloudTrail, and SP
    Unused (on complete months) all COUNT toward the commitment — an EDP is a
    spend commitment, not an infrastructure-only one, and this dollar has to be
    billed by AWS to consume it regardless of what it was for. Only genuine
    AWS-applied credits/negations (which reduce what's actually billed) are
    excluded. SP true-up lines are still suppressed entirely on a partial month
    (billing-lag artifacts — shared.cost_classifier.should_suppress_for_partial_month).
    services_data: [{service, amount, projected_amount}]
    """
    total_billed = 0.0
    credits_applied = 0.0
    marketplace_total = 0.0
    one_time_total = 0.0
    infrastructure_total = 0.0
    suppressed_total = 0.0

    for svc in services_data:
        service = svc['service']
        amount = svc.get('projected_amount', svc['amount'])

        # SP true-up lines are billing-lag artifacts mid-month — suppressed entirely,
        # not counted toward utilization or credits until the month closes.
        if is_partial and should_suppress_for_partial_month(service):
            suppressed_total += amount
            continue

        classification = classify_service(service)

        # AWS-applied credits/negations reduce the bill — excluded from utilization.
        if classification['pattern'] == 'credit':
            credits_applied += abs(amount)
            continue

        # Everything else counts toward EDP — it was billed, so it consumes commitment.
        total_billed += amount

        # Bucketed by classify_charge_bucket (not classification['pattern']) so support
        # fees and variable adjustments — recurring and projected, but not infrastructure
        # — still land in "one-time / other" for this breakdown rather than leaking into
        # infrastructure_total just because their pattern is no longer 'one_time'.
        if 'marketplace' in service.lower():
            marketplace_total += amount
        elif classify_charge_bucket(service) == 'infrastructure':
            infrastructure_total += amount
        else:
            one_time_total += amount

    net_toward_edp = total_billed  # credit-pattern lines were never added, so already net
    utilization_pct = (net_toward_edp / monthly_obligation * 100) if monthly_obligation > 0 else 0

    # <85%: At Risk · 85-95%: Watch · 95-110%: On Track · >110%: Over-Committed (still
    # healthy for an EDP — it just means more than the obligation was consumed).
    if utilization_pct < 85:
        status, status_label, status_color = 'at_risk', 'At Risk for Renewal', 'red'
    elif utilization_pct < 95:
        status, status_label, status_color = 'watch', 'Watch — Below Target', 'yellow'
    elif utilization_pct <= 110:
        status, status_label, status_color = 'on_track', 'On Track', 'green'
    else:
        status, status_label, status_color = 'over_committed', 'Over Committed — Strong Renewal Position', 'green'

    return {
        'net_toward_edp': net_toward_edp,
        'infrastructure_spend': infrastructure_total,
        'marketplace_spend': marketplace_total,
        'one_time_spend': one_time_total,
        'credits_applied': credits_applied,
        'suppressed_partial_month': suppressed_total,
        'monthly_obligation': monthly_obligation,
        'utilization_pct': utilization_pct,
        'status': status,
        'status_label': status_label,
        'status_color': status_color,
        'on_track': status in ('on_track', 'over_committed'),
    }


def get_service_amount(services_data: list, name: str) -> float:
    """Sum amount(s) for services whose name matches `name` (substring, case-insensitive)."""
    name_lower = name.lower()
    return sum(
        s.get('projected_amount', s.get('amount', 0.0))
        for s in services_data
        if name_lower in s['service'].lower()
    )


def priority_rank(priority: str) -> int:
    return {'Critical': 0, 'High': 1, 'Medium': 2, 'Low': 3}.get(priority, 4)


def optional_matched_rule(service_name: str) -> Optional[str]:
    return classify_service(service_name).get('matched_rule')


# ── charge-bucket classification (cost_history GET / dashboard / EDP) ─────────
#
# A second, coarser classification used specifically for the four cost_history
# reporting buckets: infrastructure (trending + EDP), one_time (shown separately,
# never trended or projected), billing_adjustment (footnote only), and sp_true_up
# (Savings Plan / RI true-up lines that are billing-lag-distorted mid-month and
# must be suppressed on partial months). This is deliberately a separate function
# from classify_service — the two disagree on a few services on purpose (e.g. AWS
# Partner Pricing Adjustment is "one_time" for anomaly detection but
# "billing_adjustment" here; Savings Plan - Unused is "one_time" for anomalies but
# "sp_true_up" here) because the bucket a service belongs to for cost_history
# trending isn't always the same bucket it belongs to for anomaly flagging.

CHARGE_BUCKET_ONE_TIME = [
    'Amazon Marketplace',
    'AWS Marketplace',
    'AWS Config',
    'AWS CloudTrail',
    'Certificate Manager',
]

# Recurring, but not infrastructure — support/management fees that accrue monthly
# (often as a % of total spend) rather than for a specific compute/storage resource.
# Included in EDP utilization and projected linearly on a partial month, but kept
# out of infrastructureSpend so they never distort the infrastructure MoM trend.
CHARGE_BUCKET_SUPPORT_FEE = [
    'Enterprise Support',
    'AWS Support',
]

# AWS billing adjustments that scale with total monthly spend (not a flat one-time
# correction) — same treatment as support fees: counted toward EDP, projected
# linearly on a partial month, excluded from the infrastructure MoM trend.
_VARIABLE_ADJUSTMENT_NAMES = ['aws partner pricing adjustment']

_SP_TRUE_UP_KEYWORDS = ['negation', 'ri credit', 'ri volume discount', 'reserved instance']
_SP_TRUE_UP_NAMES = [
    'savings plan - unused',
    'database savings plan - unused',
    'compute savings plan - unused',
]

_BILLING_ADJUSTMENT_KEYWORDS = ['refund', 'credit']


def classify_charge_bucket(service_name: str) -> str:
    """Returns one of: 'infrastructure' | 'one_time' | 'billing_adjustment' | 'sp_true_up'
    | 'support_fee' | 'variable_adjustment'."""
    service_lower = service_name.lower()

    # SP true-up checked first — "Negation Credit(s)" would otherwise match the
    # generic "credit" billing-adjustment keyword below.
    if any(name in service_lower for name in _SP_TRUE_UP_NAMES):
        return 'sp_true_up'
    if any(k in service_lower for k in _SP_TRUE_UP_KEYWORDS):
        return 'sp_true_up'

    if _matches_any(service_lower, CHARGE_BUCKET_SUPPORT_FEE):
        return 'support_fee'

    if any(name in service_lower for name in _VARIABLE_ADJUSTMENT_NAMES):
        return 'variable_adjustment'

    if _matches_any(service_lower, CHARGE_BUCKET_ONE_TIME):
        return 'one_time'

    if any(k in service_lower for k in _BILLING_ADJUSTMENT_KEYWORDS):
        return 'billing_adjustment'

    return 'infrastructure'


# Service-name substrings for SP/RI true-up lines that are billing-lag artifacts and
# resolve at month-end true-up — showing them mid-month is misleading, so on a partial
# month they are suppressed entirely (not just excluded from the infrastructure total,
# but dropped from every bucket, anomaly/opportunity list, and AI prompt context).
_SUPPRESS_FOR_PARTIAL_PATTERNS = [
    "savings plan - unused",
    "database savings plan - unused",
    "compute savings plan - unused",
    "savings plan negation",
    "savings plan - negation",
    "ri negation",
    "reserved instance negation",
    "database savings plan negation",
    "elasticache - database savings plan negation",
    "ec2 container service - savings plan negation",
    "rds - database savings plan negation",
    "dynamodb - database savings plan negation",
]


def should_suppress_for_partial_month(service_name: str) -> bool:
    service_lower = service_name.lower()
    return any(p in service_lower for p in _SUPPRESS_FOR_PARTIAL_PATTERNS)
