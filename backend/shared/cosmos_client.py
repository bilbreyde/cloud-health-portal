import os
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from azure.cosmos import CosmosClient, PartitionKey, exceptions

from .models import CostHistoryRecord, Customer, ExceptionRecord, MarketplacePurchase, Report, Template, TrendData, Upload
from .cost_classifier import classify_charge_bucket, classify_service, should_suppress_for_partial_month
from .cost_classifier import project_amount as classify_project_amount
from .spend_insights_engine import is_partial_month, project_amount


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
    "cost_history": "/customerId",
    "marketplace_purchases": "/customerId",
}

# customers container is special — the customer IS the partition, so we store
# id == customerId for that container and use id as the partition key.
_CUSTOMER_PARTITION_KEY = "/id"


_client: Optional[CosmosClient] = None


def _get_client() -> CosmosClient:
    # Reuse a single client (and its connection pool) across calls instead of
    # re-establishing a fresh Cosmos connection per call — the official SDK
    # guidance, and the difference between a bulk import finishing in seconds
    # vs. timing out on hundreds/thousands of individual writes.
    global _client
    if _client is None:
        conn_str = os.environ["COSMOS_CONNECTION_STRING"]
        _client = CosmosClient.from_connection_string(conn_str)
    return _client


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


def delete_trend(trend_id: str, customer_id: str) -> None:
    container = _get_container("trend_data")
    container.delete_item(item=trend_id, partition_key=customer_id)


def delete_trends_for_upload(
    customer_id: str, month: int, year: int, service_type: str, snapshot_date: str,
) -> int:
    """Delete TrendData records linked to one Upload — same match rule patch_upload
    uses to find "linked" trends (customer/month/year/serviceType/snapshotDate).
    Returns the number of records deleted."""
    matches = [
        t for t in list_trends(customer_id, year=year, service_type=service_type)
        if t.month == month and t.snapshotDate == snapshot_date
    ]
    for t in matches:
        delete_trend(t.id, customer_id)
    return len(matches)


def delete_trends_for_month(customer_id: str, month: int, year: int) -> int:
    """Delete ALL TrendData records for a customer/month/year, across every service
    and snapshot — for bulk cleanup independent of any single upload. Returns the
    number of records deleted."""
    matches = [t for t in list_trends(customer_id, year=year) if t.month == month]
    for t in matches:
        delete_trend(t.id, customer_id)
    return len(matches)


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


def delete_dashboard_cache(customer_id: str) -> None:
    container = _get_container("reports")
    try:
        container.delete_item(item=f'dash-{customer_id}', partition_key=customer_id)
    except exceptions.CosmosResourceNotFoundError:
        pass


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


# ── cost_history ─────────────────────────────────────────────────────────────

def upsert_cost_history(
    customer_id: str,
    month: str,
    service: str,
    amount: float,
    charge_type: str,
    imported_at: Optional[datetime] = None,
    source_file: str = '',
) -> CostHistoryRecord:
    # Deterministic id so re-importing the same CSV overwrites rather than duplicates.
    doc_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f'{customer_id}:{month}:{charge_type}:{service}'))
    record = CostHistoryRecord(
        id=doc_id,
        customerId=customer_id,
        month=month,
        service=service,
        amount=amount,
        chargeType=charge_type,
        importedAt=imported_at or datetime.now(timezone.utc),
        sourceFile=source_file,
    )
    container = _get_container('cost_history')
    container.upsert_item(record.to_dict())
    return record


_BATCH_LIMIT = 100  # Cosmos transactional batch max operations per call


def delete_cost_history_for_customer(customer_id: str) -> int:
    """Delete every existing cost_history row for a customer.

    Import is upsert-only, so it never removes rows that no longer appear in a
    re-imported CSV — a fixed parser stops writing *new* bad rows but leaves
    already-imported bad ones (e.g. a stale "Total" grand-total row mistaken for
    a service) sitting in Cosmos forever. A CostHistory export is a full
    cumulative snapshot, not an incremental log, so re-import should fully
    replace prior data for that customer, not merge with it. Call this
    immediately before upsert_cost_history_bulk on import. Returns the number
    of rows deleted.
    """
    container = _get_container('cost_history')
    existing = get_cost_history(customer_id, '0000-00', '9999-99')
    ids = [r.id for r in existing]
    for i in range(0, len(ids), _BATCH_LIMIT):
        chunk = ids[i:i + _BATCH_LIMIT]
        batch_ops = [('delete', (doc_id,)) for doc_id in chunk]
        container.execute_item_batch(batch_ops, partition_key=customer_id)
    return len(ids)


def upsert_cost_history_bulk(
    customer_id: str,
    records: list,
    imported_at: Optional[datetime] = None,
    source_file: str = '',
) -> list[CostHistoryRecord]:
    """Upsert many cost_history rows for one customer in one import.

    A CostHistory CSV can produce thousands of (service, month) cells, and one
    upsert_item call per cell — even with a reused client — is still one network
    round trip per cell. Every row here shares the same customerId partition key,
    so they're eligible for Cosmos transactional batches: up to 100 operations
    per round trip instead of one, which is what keeps a large import inside the
    Function App's request timeout instead of hitting a Gateway Timeout.

    `records` is a list of dicts: {month, service, amount, chargeType}.
    """
    imported_at = imported_at or datetime.now(timezone.utc)
    container = _get_container('cost_history')

    built: list[CostHistoryRecord] = []
    for rec in records:
        doc_id = str(uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"{customer_id}:{rec['month']}:{rec['chargeType']}:{rec['service']}",
        ))
        built.append(CostHistoryRecord(
            id=doc_id,
            customerId=customer_id,
            month=rec['month'],
            service=rec['service'],
            amount=rec['amount'],
            chargeType=rec['chargeType'],
            importedAt=imported_at,
            sourceFile=source_file,
        ))

    for i in range(0, len(built), _BATCH_LIMIT):
        chunk = built[i:i + _BATCH_LIMIT]
        batch_ops = [('upsert', (r.to_dict(),)) for r in chunk]
        container.execute_item_batch(batch_ops, partition_key=customer_id)

    return built


def get_cost_history(customer_id: str, start_month: str, end_month: str) -> list[CostHistoryRecord]:
    container = _get_container('cost_history')
    query = (
        'SELECT * FROM c WHERE c.customerId = @customerId '
        'AND c.month >= @startMonth AND c.month <= @endMonth'
    )
    params = [
        {'name': '@customerId', 'value': customer_id},
        {'name': '@startMonth', 'value': start_month},
        {'name': '@endMonth', 'value': end_month},
    ]
    items = container.query_items(query=query, parameters=params, partition_key=customer_id)
    results = [CostHistoryRecord.from_dict(i) for i in items]
    return sorted(results, key=lambda r: (r.month, r.chargeType, r.service))


def get_cost_history_summary(customer_id: str, months: list) -> dict:
    """Aggregate cost_history records for the given months into dashboard-ready shape."""
    empty = {
        'monthlyTotals': [],
        'byService': [],
        'topServices': [],
        'savingsPlanCoverage': {'covered': 0.0, 'onDemand': 0.0, 'coveragePct': 0.0},
        'projectedCurrentMonth': 0.0,
        'isPartial': False,
        'completionRatio': 1.0,
    }
    months_sorted = sorted(set(months))
    if not months_sorted:
        return empty

    records = get_cost_history(customer_id, months_sorted[0], months_sorted[-1])
    records = [r for r in records if r.month in months_sorted]
    if not records:
        return empty

    # ── partial-month detection ────────────────────────────────────────────────
    # The most recent month can be a real, still-in-progress calendar month with
    # fewer days of billing data than every prior (closed) month — comparing its
    # raw to-date total against a full prior month understates MoM change and can
    # look like a cost decrease that isn't real. is_partial/completion_ratio drive
    # every MoM figure below; a closed month is always (False, 1.0), a no-op.
    current_month = months_sorted[-1]
    previous_month = months_sorted[-2] if len(months_sorted) >= 2 else None
    is_partial, completion_ratio = is_partial_month(current_month)

    # ── monthly totals (direct / indirect / net) ──────────────────────────────
    direct_by_month: dict[str, float] = {m: 0.0 for m in months_sorted}
    indirect_by_month: dict[str, float] = {m: 0.0 for m in months_sorted}
    ec2_compute_by_month: dict[str, float] = {m: 0.0 for m in months_sorted}
    savings_plan_by_month: dict[str, float] = {m: 0.0 for m in months_sorted}
    by_service_month: dict[str, dict[str, float]] = {}

    # Charge-bucket totals (infrastructure / one_time / billing_adjustment / sp_true_up)
    # per shared.cost_classifier.classify_charge_bucket — drives infrastructureSpend,
    # oneTimeCharges, billingAdjustments, spTrueUp, totalBilled and netBilled below.
    bucket_by_month: dict[str, dict[str, float]] = {
        m: {'infrastructure': 0.0, 'one_time': 0.0, 'billing_adjustment': 0.0, 'sp_true_up': 0.0}
        for m in months_sorted
    }
    gross_by_month: dict[str, float] = {m: 0.0 for m in months_sorted}  # sum of positive-amount lines only

    for r in records:
        # SP/RI true-up lines (Savings Plan Unused, SP/RI Negation, ...) are billing-lag
        # artifacts that resolve at month-end true-up — on the partial current month
        # they're dropped from the record set entirely: not direct/indirect totals, not
        # any bucket, not by_service_month (so they don't surface in byService/anomalies/
        # opportunities either). Prior closed months are unaffected.
        if is_partial and r.month == current_month and should_suppress_for_partial_month(r.service):
            continue

        normalized_service = re.sub(r'\s+', ' ', r.service.strip().lower())
        if r.chargeType == 'indirect':
            indirect_by_month[r.month] = indirect_by_month.get(r.month, 0.0) + r.amount
            if 'savings plan' in normalized_service:
                savings_plan_by_month[r.month] = savings_plan_by_month.get(r.month, 0.0) + r.amount
        else:
            direct_by_month[r.month] = direct_by_month.get(r.month, 0.0) + r.amount
            if normalized_service == 'ec2 - compute':
                ec2_compute_by_month[r.month] = ec2_compute_by_month.get(r.month, 0.0) + r.amount
        by_service_month.setdefault(r.service, {})
        by_service_month[r.service][r.month] = by_service_month[r.service].get(r.month, 0.0) + r.amount

        bucket = classify_charge_bucket(r.service)
        bucket_by_month[r.month][bucket] = bucket_by_month[r.month].get(bucket, 0.0) + r.amount
        if r.amount > 0:
            gross_by_month[r.month] = gross_by_month.get(r.month, 0.0) + r.amount

    marketplace_notes_by_month = {p.month: p.vendorNote for p in list_marketplace_purchases(customer_id)}
    marketplace_amount_by_month = next(
        (mv for s, mv in by_service_month.items() if s.strip().lower() == 'amazon marketplace'), {},
    )

    monthly_totals = []
    for m in months_sorted:
        direct = round(direct_by_month.get(m, 0.0), 2)
        indirect = round(indirect_by_month.get(m, 0.0), 2)
        net = round(direct + indirect, 2)
        m_is_partial = is_partial and m == current_month
        ratio = completion_ratio if m_is_partial else 1.0

        # sp_true_up (Savings Plan/RI true-up lines) is billing-lag-distorted mid-month
        # (rules 4/5) — fold into infrastructureSpend only once the month has closed,
        # and report the field itself as 0 while partial rather than the noisy raw value.
        buckets = bucket_by_month.get(m, {})
        sp_true_up_raw = round(buckets.get('sp_true_up', 0.0), 2)
        sp_true_up = 0.0 if m_is_partial else sp_true_up_raw
        infrastructure_spend = round(buckets.get('infrastructure', 0.0) + sp_true_up, 2)
        one_time_charges = round(buckets.get('one_time', 0.0), 2)
        billing_adjustments = round(buckets.get('billing_adjustment', 0.0), 2)
        total_billed = round(gross_by_month.get(m, 0.0), 2)   # gross: positive-amount lines only
        net_billed = net                                       # net: everything summed, credits already netted in

        marketplace_amount = marketplace_amount_by_month.get(m, 0.0)
        marketplace_purchases = (
            [{'amount': round(marketplace_amount, 2), 'vendorNote': marketplace_notes_by_month.get(m)}]
            if marketplace_amount > 0 else []
        )

        monthly_totals.append({
            'month': m,
            'directCharges': direct,
            'indirectCharges': indirect,
            'netCost': net,
            'isPartial': m_is_partial,
            'completionRatio': round(ratio, 4),
            'projectedDirectCharges': round(project_amount(direct, ratio), 2) if m_is_partial else direct,
            'projectedNetCost': round(project_amount(net, ratio), 2) if m_is_partial else net,
            'infrastructureSpend': infrastructure_spend,
            'projectedInfrastructureSpend': round(project_amount(infrastructure_spend, ratio), 2)
                if m_is_partial else infrastructure_spend,
            'oneTimeCharges': one_time_charges,
            'billingAdjustments': billing_adjustments,
            'spTrueUp': sp_true_up,
            'totalBilled': total_billed,
            'netBilled': net_billed,
            'marketplacePurchases': marketplace_purchases,
        })

    # ── by-service breakdown + trend ───────────────────────────────────────────
    # Trend compares a service's most recent two data points; if the most recent one
    # lands in the partial current month, project it (classification-aware — a
    # one-time charge like Amazon Marketplace is never scaled up) before comparing,
    # so a mid-month snapshot doesn't read as a decline against a full prior month.
    by_service = []
    for service, month_vals in by_service_month.items():
        classification = classify_service(service)
        present_months = [m for m in months_sorted if m in month_vals]
        ordered = [month_vals[m] for m in present_months]
        trend = 'flat'
        if len(ordered) >= 2:
            last_val = ordered[-1]
            if is_partial and present_months[-1] == current_month:
                last_val, _ = classify_project_amount(last_val, service, completion_ratio)
            delta = last_val - ordered[-2]
            threshold = max(50.0, abs(ordered[-2]) * 0.03)
            if delta > threshold:
                trend = 'up'
            elif delta < -threshold:
                trend = 'down'
        by_service.append({
            'service': service,
            'months': {m: round(v, 2) for m, v in month_vals.items()},
            'trend': trend,
            'pattern': classification['pattern'],
        })
    by_service.sort(key=lambda s: -sum(s['months'].values()))

    # ── top services this month ────────────────────────────────────────────────
    # currentMonth stays the raw to-date figure (what's actually been billed so
    # far); projectedAmount is the classification-aware run-rate estimate MoM math
    # is based on — a one-time charge is reported unscaled even here.
    top_services = []
    for service, month_vals in by_service_month.items():
        classification = classify_service(service)
        curr = month_vals.get(current_month, 0.0)
        prev = month_vals.get(previous_month, 0.0) if previous_month else 0.0
        if is_partial:
            curr_projected, _ = classify_project_amount(curr, service, completion_ratio)
        else:
            curr_projected = curr
        mom_delta = curr_projected - prev
        mom_pct = (mom_delta / prev * 100) if prev else None
        top_services.append({
            'service': service,
            'currentMonth': round(curr, 2),
            'previousMonth': round(prev, 2),
            'isPartial': is_partial,
            'projectedAmount': round(curr_projected, 2),
            'pattern': classification['pattern'],
            'momDelta': round(mom_delta, 2),
            'momPct': round(mom_pct, 2) if mom_pct is not None else None,
        })
    top_services.sort(key=lambda s: -s['projectedAmount'])
    top_services = top_services[:10]

    # ── savings plan coverage (current month) ──────────────────────────────────
    # Scoped to compute, not total spend: Savings Plans apply against EC2 compute
    # usage specifically, not storage/transfer/etc. "Covered" is the absolute value
    # of indirect rows whose service name names a Savings Plan (the indirect section
    # can carry other credit/negation types too, e.g. RI amortization, which aren't
    # part of this ratio). "On demand" is the direct EC2 - Compute total itself —
    # Savings Plan usage is billed as a negation against that same line, so the
    # negation's magnitude is already part of ec2_compute_direct, not on top of it.
    # Not projected: both sides are the same to-date period, so the ratio between
    # them holds regardless of how much of the month has elapsed.
    covered = abs(savings_plan_by_month.get(current_month, 0.0))
    ec2_compute_direct = ec2_compute_by_month.get(current_month, 0.0)
    on_demand = max(0.0, ec2_compute_direct)
    coverage_pct = round((covered / (covered + on_demand) * 100), 1) if (covered + on_demand) > 0 else 0.0
    direct_total = direct_by_month.get(current_month, 0.0)

    projected_current_month = round(project_amount(direct_total, completion_ratio), 2) if is_partial \
        else round(direct_total, 2)

    return {
        'monthlyTotals': monthly_totals,
        'byService': by_service,
        'topServices': top_services,
        'savingsPlanCoverage': {
            'covered': round(covered, 2),
            'onDemand': round(on_demand, 2),
            'coveragePct': coverage_pct,
        },
        'projectedCurrentMonth': projected_current_month,
        'isPartial': is_partial,
        'completionRatio': round(completion_ratio, 4),
    }


# ── marketplace_purchases ────────────────────────────────────────────────────

def _marketplace_purchase_id(customer_id: str, month: str) -> str:
    # Deterministic — at most one purchase record per (customer, month), matching
    # "Amazon Marketplace" being a single summed line per month in cost_history.
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f'marketplace-purchase:{customer_id}:{month}'))


def upsert_marketplace_purchase_amount(customer_id: str, month: str, amount: float) -> MarketplacePurchase:
    """Called from CostHistory import: create the record with vendorNote=None if it
    doesn't exist yet, or update the amount while preserving any existing vendorNote."""
    container = _get_container('marketplace_purchases')
    doc_id = _marketplace_purchase_id(customer_id, month)
    now = datetime.now(timezone.utc)
    try:
        existing = container.read_item(item=doc_id, partition_key=customer_id)
        record = MarketplacePurchase.from_dict(existing)
        record.amount = amount
        record.updatedAt = now
    except exceptions.CosmosResourceNotFoundError:
        record = MarketplacePurchase(
            id=doc_id, customerId=customer_id, month=month, amount=amount,
            vendorNote=None, importedAt=now, updatedAt=now,
        )
    container.upsert_item(record.to_dict())
    return record


def list_marketplace_purchases(customer_id: str) -> list[MarketplacePurchase]:
    container = _get_container('marketplace_purchases')
    items = container.query_items(
        query='SELECT * FROM c WHERE c.customerId = @customerId',
        parameters=[{'name': '@customerId', 'value': customer_id}],
        partition_key=customer_id,
    )
    results = [MarketplacePurchase.from_dict(i) for i in items]
    return sorted(results, key=lambda r: r.month, reverse=True)


def get_marketplace_purchase(customer_id: str, month: str) -> Optional[MarketplacePurchase]:
    container = _get_container('marketplace_purchases')
    doc_id = _marketplace_purchase_id(customer_id, month)
    try:
        return MarketplacePurchase.from_dict(container.read_item(item=doc_id, partition_key=customer_id))
    except exceptions.CosmosResourceNotFoundError:
        return None


def update_marketplace_purchase_note(customer_id: str, month: str, vendor_note: str) -> Optional[MarketplacePurchase]:
    record = get_marketplace_purchase(customer_id, month)
    if record is None:
        return None
    record.vendorNote = vendor_note
    record.updatedAt = datetime.now(timezone.utc)
    container = _get_container('marketplace_purchases')
    container.upsert_item(record.to_dict())
    return record
