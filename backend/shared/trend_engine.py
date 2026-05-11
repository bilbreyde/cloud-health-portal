import re
from typing import Optional, Tuple

import pandas as pd

SMALL_DELTA_ABS = 10.0

# Ordered from most-specific to least-specific so earlier matches win
_SAVINGS_KEYWORDS = ['net saving', 'total saving', 'saving']
_COST_KEYWORDS = ['unblended cost', 'amortized cost', 'net cost', 'cost', 'spend', 'amount', 'charge', 'fee']

_SERVICE_MAP = [
    ('elasticache', 'ElastiCache'),
    ('opensearch', 'OpenSearch'),
    ('elasticsearch', 'OpenSearch'),
    ('dynamodb', 'DynamoDB'),
    ('redshift', 'Redshift'),
    ('ec2', 'EC2'),
    ('rds', 'RDS'),
    ('ebs', 'EBS'),
    ('s3', 'S3'),
]


def detect_savings_column(df: pd.DataFrame) -> Optional[str]:
    """Return the first column whose name contains a savings or cost keyword."""
    cols_lower = {c.lower(): c for c in df.columns}
    for kw in _SAVINGS_KEYWORDS + _COST_KEYWORDS:
        for lower, orig in cols_lower.items():
            if kw in lower:
                return orig
    return None


def clean_numeric_series(s: pd.Series) -> pd.Series:
    """Strip $, commas, whitespace; convert (n) accounting negatives; coerce to float."""
    if pd.api.types.is_numeric_dtype(s):
        return s.fillna(0.0).astype(float)
    s = s.astype(str).str.strip()
    # (1,234.56) → -1234.56
    s = s.str.replace(r'^\((.+)\)$', r'-\1', regex=True)
    s = s.str.replace(r'[$,\s]', '', regex=True)
    return pd.to_numeric(s, errors='coerce').fillna(0.0)


def normalize_filename_to_key(filename: str) -> str:
    """Strip extension, lowercase, collapse non-alphanumeric runs to underscores."""
    name = filename.rsplit('.', 1)[0]
    name = name.lower()
    name = re.sub(r'[^a-z0-9]+', '_', name)
    return name.strip('_')


def detect_service_type(filename: str, df_columns: list) -> str:
    """Return the AWS service name inferred from the filename, falling back to column headers."""
    needle = filename.lower()
    for keyword, service in _SERVICE_MAP:
        if keyword in needle:
            return service
    col_text = ' '.join(df_columns).lower()
    for keyword, service in _SERVICE_MAP:
        if keyword in col_text:
            return service
    return 'Consolidated'


def compute_mom_delta(current: float, previous: float) -> Tuple[float, str]:
    """Return (delta_amount, direction) where direction is Up / Down / Flat."""
    delta = current - previous
    if delta > SMALL_DELTA_ABS:
        direction = 'Up'
    elif delta < -SMALL_DELTA_ABS:
        direction = 'Down'
    else:
        direction = 'Flat'
    return round(delta, 2), direction


def aggregate_csv(df: pd.DataFrame, service_type: str) -> dict:
    """Return {'savingsTotal': float, 'rowCount': int} from the best numeric column."""
    col = detect_savings_column(df)
    if col is None:
        return {'savingsTotal': 0.0, 'rowCount': len(df)}
    series = clean_numeric_series(df[col])
    return {
        'savingsTotal': round(float(series.sum()), 2),
        'rowCount': int((series != 0).sum()),
    }
