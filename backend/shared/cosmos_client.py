import os
from datetime import timezone
from typing import Optional

from azure.cosmos import CosmosClient, PartitionKey, exceptions

from .models import Customer, ExceptionRecord, Report, Template, TrendData, Upload


def _utc(dt):
    """Normalize datetime to UTC-aware for safe comparison."""
    return dt if (dt is None or dt.tzinfo is not None) else dt.replace(tzinfo=timezone.utc)

_DB_NAME = "cloud-health-portal"
_CONTAINERS = {
    "customers": "/customerId",
    "uploads": "/customerId",
    "trend_data": "/customerId",
    "reports": "/customerId",
    "templates": "/customerId",
    "exceptions": "/customerId",
}

# customers container is special — the customer IS the partition, so we store
# id == customerId for that container and use id as the partition key.
_CUSTOMER_PARTITION_KEY = "/id"


def _get_client() -> CosmosClient:
    conn_str = os.environ["COSMOS_CONNECTION_STRING"]
    return CosmosClient.from_connection_string(conn_str)


def _get_container(name: str):
    client = _get_client()
    db = client.get_database_client(_DB_NAME)
    return db.get_container_client(name)


def ensure_schema() -> None:
    """Create database and containers if they do not already exist."""
    client = _get_client()
    db = client.create_database_if_not_exists(_DB_NAME)
    for container_name, pk_path in _CONTAINERS.items():
        actual_pk = _CUSTOMER_PARTITION_KEY if container_name == "customers" else pk_path
        db.create_container_if_not_exists(
            id=container_name,
            partition_key=PartitionKey(path=actual_pk),
        )


# ── customers ─────────────────────────────────────────────────────────────────

def create_customer(customer: Customer) -> Customer:
    container = _get_container("customers")
    doc = customer.to_dict()
    doc["id"] = customer.id  # partition key == id for this container
    container.create_item(doc)
    return customer


def get_customer(customer_id: str) -> Optional[Customer]:
    container = _get_container("customers")
    try:
        doc = container.read_item(item=customer_id, partition_key=customer_id)
        return Customer.from_dict(doc)
    except exceptions.CosmosResourceNotFoundError:
        return None


def list_customers() -> list[Customer]:
    container = _get_container("customers")
    items = container.query_items(
        query="SELECT * FROM c ORDER BY c.name",
        enable_cross_partition_query=True,
    )
    return [Customer.from_dict(i) for i in items]


def update_customer(customer: Customer) -> Customer:
    container = _get_container("customers")
    doc = customer.to_dict()
    doc["id"] = customer.id
    container.upsert_item(doc)
    return customer


def delete_customer(customer_id: str) -> None:
    container = _get_container("customers")
    container.delete_item(item=customer_id, partition_key=customer_id)


# ── uploads ───────────────────────────────────────────────────────────────────

def create_upload(upload: Upload) -> Upload:
    container = _get_container("uploads")
    container.create_item(upload.to_dict())
    return upload


def get_upload(upload_id: str, customer_id: str) -> Optional[Upload]:
    container = _get_container("uploads")
    try:
        doc = container.read_item(item=upload_id, partition_key=customer_id)
        return Upload.from_dict(doc)
    except exceptions.CosmosResourceNotFoundError:
        return None


def list_uploads(customer_id: str, month: Optional[int] = None, year: Optional[int] = None) -> list[Upload]:
    container = _get_container("uploads")
    filters: list[str] = ["c.customerId = @customerId"]
    params: list[dict] = [{"name": "@customerId", "value": customer_id}]
    if month is not None:
        filters.append("c.month = @month")
        params.append({"name": "@month", "value": month})
    if year is not None:
        filters.append("c.year = @year")
        params.append({"name": "@year", "value": year})
    query = f"SELECT * FROM c WHERE {' AND '.join(filters)}"
    items = container.query_items(query=query, parameters=params, partition_key=customer_id)
    results = [Upload.from_dict(i) for i in items]
    return sorted(results, key=lambda u: (u.snapshotDate or u.uploadedAt.isoformat()), reverse=True)


def update_upload(upload: Upload) -> Upload:
    container = _get_container("uploads")
    container.upsert_item(upload.to_dict())
    return upload


def delete_upload(upload_id: str, customer_id: str) -> None:
    container = _get_container("uploads")
    container.delete_item(item=upload_id, partition_key=customer_id)


# ── trend_data ────────────────────────────────────────────────────────────────

def create_trend(trend: TrendData) -> TrendData:
    container = _get_container("trend_data")
    container.create_item(trend.to_dict())
    return trend


def get_trend(trend_id: str, customer_id: str) -> Optional[TrendData]:
    container = _get_container("trend_data")
    try:
        doc = container.read_item(item=trend_id, partition_key=customer_id)
        return TrendData.from_dict(doc)
    except exceptions.CosmosResourceNotFoundError:
        return None


def list_trends(customer_id: str, year: Optional[int] = None, service_type: Optional[str] = None) -> list[TrendData]:
    container = _get_container("trend_data")
    filters: list[str] = ["c.customerId = @customerId"]
    params: list[dict] = [{"name": "@customerId", "value": customer_id}]
    if year is not None:
        filters.append("c.year = @year")
        params.append({"name": "@year", "value": year})
    if service_type is not None:
        filters.append("c.serviceType = @serviceType")
        params.append({"name": "@serviceType", "value": service_type})
    query = f"SELECT * FROM c WHERE {' AND '.join(filters)}"
    items = container.query_items(query=query, parameters=params, partition_key=customer_id)
    results = [TrendData.from_dict(i) for i in items]
    return sorted(results, key=lambda t: (t.year, t.month), reverse=True)


def upsert_trend(trend: TrendData) -> TrendData:
    container = _get_container("trend_data")
    container.upsert_item(trend.to_dict())
    return trend


# ── reports ───────────────────────────────────────────────────────────────────

def create_report(report: Report) -> Report:
    container = _get_container("reports")
    container.create_item(report.to_dict())
    return report


def get_report(report_id: str, customer_id: str) -> Optional[Report]:
    container = _get_container("reports")
    try:
        doc = container.read_item(item=report_id, partition_key=customer_id)
        return Report.from_dict(doc)
    except exceptions.CosmosResourceNotFoundError:
        return None


def list_reports(customer_id: str, year: Optional[int] = None) -> list[Report]:
    container = _get_container("reports")
    filters: list[str] = ["c.customerId = @customerId"]
    params: list[dict] = [{"name": "@customerId", "value": customer_id}]
    if year is not None:
        filters.append("c.year = @year")
        params.append({"name": "@year", "value": year})
    query = f"SELECT * FROM c WHERE {' AND '.join(filters)}"
    items = container.query_items(query=query, parameters=params, partition_key=customer_id)
    results = [Report.from_dict(i) for i in items]
    return sorted(results, key=lambda r: (r.year, r.month, _utc(r.generatedAt)), reverse=True)


def update_report(report: Report) -> Report:
    container = _get_container("reports")
    container.upsert_item(report.to_dict())
    return report


def delete_report(report_id: str, customer_id: str) -> None:
    container = _get_container("reports")
    container.delete_item(item=report_id, partition_key=customer_id)


def get_reports_with_context(customer_id: str, limit: int = 10) -> list[Report]:
    """Most-recent reports that have joelNotes or extractedData, ordered by Cosmos _ts DESC.

    Uses _ts (Cosmos system write-timestamp) rather than the application-level
    generatedAt field so ordering is guaranteed regardless of reporting period.
    Cross-partition enabled so ORDER BY works reliably.
    """
    container = _get_container("reports")
    query = f"""
        SELECT * FROM c
        WHERE c.customerId = @customerId
        AND (
            (IS_DEFINED(c.joelNotes) AND c.joelNotes != null AND c.joelNotes != "")
            OR
            (IS_DEFINED(c.extractedData) AND c.extractedData != null)
        )
        ORDER BY c._ts DESC
        OFFSET 0 LIMIT {limit}
    """
    items = container.query_items(
        query=query,
        parameters=[{"name": "@customerId", "value": customer_id}],
        enable_cross_partition_query=True,
    )
    return [Report.from_dict(i) for i in items]


def get_recent_raw(customer_id: str, since_ts: int = 1750000000, limit: int = 10) -> list[dict]:
    """Raw Cosmos docs for debugging — exposes actual field names and _ts values."""
    container = _get_container("reports")
    query = f"""
        SELECT c.id, c.source, c.month, c.year, c.status,
               c.generatedAt, c._ts,
               IS_DEFINED(c.joelNotes) AS hasJoelNotesField,
               LENGTH(c.joelNotes) AS joelNotesLen,
               IS_DEFINED(c.extractedData) AS hasExtractedData
        FROM c
        WHERE c.customerId = @customerId
        AND c._ts > @since_ts
        ORDER BY c._ts DESC
        OFFSET 0 LIMIT {limit}
    """
    items = container.query_items(
        query=query,
        parameters=[
            {"name": "@customerId", "value": customer_id},
            {"name": "@since_ts", "value": since_ts},
        ],
        enable_cross_partition_query=True,
    )
    return list(items)


# ── templates ─────────────────────────────────────────────────────────────────

def create_template(template: Template) -> Template:
    container = _get_container("templates")
    container.create_item(template.to_dict())
    return template


def get_template(template_id: str, customer_id: str) -> Optional[Template]:
    container = _get_container("templates")
    try:
        doc = container.read_item(item=template_id, partition_key=customer_id)
        return Template.from_dict(doc)
    except exceptions.CosmosResourceNotFoundError:
        return None


def list_templates(customer_id: str, active_only: bool = False) -> list[Template]:
    container = _get_container("templates")
    filters: list[str] = ["c.customerId = @customerId"]
    params: list[dict] = [{"name": "@customerId", "value": customer_id}]
    if active_only:
        filters.append("c.isActive = true")
    query = f"SELECT * FROM c WHERE {' AND '.join(filters)} ORDER BY c.uploadedAt DESC"
    items = container.query_items(query=query, parameters=params, partition_key=customer_id)
    return [Template.from_dict(i) for i in items]


def upsert_template(template: Template) -> Template:
    container = _get_container("templates")
    container.upsert_item(template.to_dict())
    return template


def delete_template(template_id: str, customer_id: str) -> None:
    container = _get_container("templates")
    container.delete_item(item=template_id, partition_key=customer_id)


# ── exceptions ─────────────────────────────────────────────────────────────────

def upsert_exception(exc: ExceptionRecord) -> ExceptionRecord:
    container = _get_container("exceptions")
    container.upsert_item(exc.to_dict())
    return exc


def get_exception(exception_id: str, customer_id: str) -> Optional[ExceptionRecord]:
    container = _get_container("exceptions")
    try:
        doc = container.read_item(item=exception_id, partition_key=customer_id)
        return ExceptionRecord.from_dict(doc)
    except exceptions.CosmosResourceNotFoundError:
        return None


def list_exceptions(customer_id: str) -> list[ExceptionRecord]:
    container = _get_container("exceptions")
    items = container.query_items(
        query="SELECT * FROM c WHERE c.customerId = @customerId",
        parameters=[{"name": "@customerId", "value": customer_id}],
        partition_key=customer_id,
    )
    results = [ExceptionRecord.from_dict(i) for i in items]
    return sorted(results, key=lambda e: (e.exceptionCategory, e.instanceName))


def delete_exception(exception_id: str, customer_id: str) -> None:
    container = _get_container("exceptions")
    container.delete_item(item=exception_id, partition_key=customer_id)


def exceptions_summary(customer_id: str) -> dict:
    exc_list = list_exceptions(customer_id)
    total_cost = round(sum(e.projectedCostPerMonth for e in exc_list), 2)

    by_cat: dict[str, dict] = {}
    by_lc: dict[str, dict] = {}
    for e in exc_list:
        cat = e.exceptionCategory or 'Uncategorized'
        by_cat.setdefault(cat, {'category': cat, 'count': 0, 'monthlyCost': 0.0})
        by_cat[cat]['count'] += 1
        by_cat[cat]['monthlyCost'] = round(by_cat[cat]['monthlyCost'] + e.projectedCostPerMonth, 2)

        lc = e.lifecycle or 'Unknown'
        by_lc.setdefault(lc, {'lifecycle': lc, 'count': 0, 'monthlyCost': 0.0})
        by_lc[lc]['count'] += 1
        by_lc[lc]['monthlyCost'] = round(by_lc[lc]['monthlyCost'] + e.projectedCostPerMonth, 2)

    return {
        'totalCount': len(exc_list),
        'totalMonthlyCost': total_cost,
        'byCategory': sorted(by_cat.values(), key=lambda x: -x['monthlyCost']),
        'byLifecycle': sorted(by_lc.values(), key=lambda x: -x['monthlyCost']),
    }
