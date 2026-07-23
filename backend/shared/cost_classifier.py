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
    "Enterprise Support",
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
        "pattern": "one_time",
        "flag_type": "Billing Adjustment",
        "color": "blue",
        "description": "End-of-period billing correction from AWS. Not recurring.",
        "exclude_from_edp": True,
        "exclude_from_projection": True,
    },
    "Enterprise Support": {
        "pattern": "one_time",
        "flag_type": "Flat Monthly Fee",
        "color": "gray",
        "description": "Fixed monthly support fee charged at period start.",
        "exclude_from_edp": False,
        "exclude_from_projection": True,
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


def compute_edp_utilization(services_data: list, monthly_obligation: float) -> dict:
    """
    Compute EDP utilization excluding one-time and credit charges.
    services_data: [{service, amount, projected_amount}]
    """
    recurring_total = 0.0
    one_time_total = 0.0
    credit_total = 0.0
    excluded_services = []

    for svc in services_data:
        classification = classify_service(svc['service'])
        amount = svc.get('projected_amount', svc['amount'])
        if classification['pattern'] == 'credit':
            credit_total += abs(amount)
        elif classification['exclude_from_edp']:
            one_time_total += amount
            excluded_services.append({
                'service': svc['service'],
                'amount': amount,
                'reason': classification['flag_type'],
            })
        else:
            recurring_total += amount

    utilization_pct = (
        recurring_total / monthly_obligation * 100 if monthly_obligation > 0 else 0
    )

    return {
        'recurring_spend': recurring_total,
        'one_time_charges': one_time_total,
        'credits': credit_total,
        'net_recurring': recurring_total - credit_total,
        'monthly_obligation': monthly_obligation,
        'utilization_pct': utilization_pct,
        'on_track': 85 <= utilization_pct <= 115,
        'excluded_services': excluded_services,
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
