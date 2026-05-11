from dataclasses import dataclass
from datetime import date


@dataclass
class CostRecord:
    customer_id: str
    service: str
    amount: float
    currency: str
    period_start: date
    period_end: date


@dataclass
class TrendResult:
    customer_id: str
    service: str
    trend_pct: float
    recommendation: str
