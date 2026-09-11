from . import cosmos_client

# Rough monthly on-demand price approximation ($/month) for a handful of common EC2
# types, used only to estimate rightsizing savings when both the original and
# current instance type are covered. Not a pricing API substitute — see
# estimate_rightsizing_savings() for the fallback when a type isn't in this table.
EC2_PRICING_APPROX = {
    't3.small': 15, 't3.medium': 30, 't3.large': 60,
    't3.xlarge': 120, 't3.2xlarge': 240,
    'm6i.large': 70, 'm6i.xlarge': 140, 'm6i.2xlarge': 280,
    'm6i.4xlarge': 560, 'm6i.8xlarge': 1120,
    'm7i.large': 75, 'm7i.xlarge': 150, 'm7i.2xlarge': 300,
    'm7i.4xlarge': 600,
    'r7i.xlarge': 180, 'r7i.2xlarge': 360,
    'c5.xlarge': 110, 'c8i.4xlarge': 500,
}


def estimate_rightsizing_savings(original_type: str, current_type: str) -> float | None:
    """Positive = downsize (savings), negative = upsize (cost increase). None when
    either type isn't in the approximation table — caller falls back to comparing
    actual monthly costs from the exceptions register / inventory import instead."""
    if original_type in EC2_PRICING_APPROX and current_type in EC2_PRICING_APPROX:
        return round(EC2_PRICING_APPROX[original_type] - EC2_PRICING_APPROX[current_type], 2)
    return None


def reconcile(customer_id: str, snapshot_date: str) -> dict:
    exceptions = cosmos_client.list_exceptions(customer_id)
    instances = cosmos_client.list_inventory_instances(customer_id, snapshot_date)
    inv_by_id = {i.instanceId: i for i in instances if i.instanceId}

    # Same Instance Name + Account can appear more than once in the exceptions
    # register — CloudHealth recalculates each instance's projected cost every time
    # the register is exported, so a re-import (or a register that already listed
    # an instance twice) produces near-duplicate rows that differ only in cost.
    # Deduplicated by the (instanceName, accountName) pair — instanceId isn't a
    # reliable key here since a terminated instance's id is sometimes blank/stale
    # in the register — keeping the highest monthly cost as the more conservative
    # (larger) savings estimate.
    terminated_by_key: dict[tuple, dict] = {}
    duplicates_removed = 0
    rightsized: list[dict] = []
    active_unchanged: list[dict] = []

    for exc in exceptions:
        inv = inv_by_id.get(exc.instanceId) if exc.instanceId else None

        if inv is None:
            record = {
                'instanceId': exc.instanceId,
                'instanceName': exc.instanceName,
                'accountName': exc.accountName,
                'lifecycle': exc.lifecycle,
                'product': exc.product,
                'originalType': exc.apiName,
                'originalMonthlyCost': round(exc.projectedCostPerMonth, 2),
                'appOwner': exc.appOwner,
                'notes': exc.notes,
            }
            key = (exc.instanceName.strip().lower(), exc.accountName.strip().lower())
            existing = terminated_by_key.get(key)
            if existing is None:
                terminated_by_key[key] = record
            else:
                duplicates_removed += 1
                if record['originalMonthlyCost'] > existing['originalMonthlyCost']:
                    terminated_by_key[key] = record
        elif inv.apiName and exc.apiName and inv.apiName != exc.apiName:
            savings = estimate_rightsizing_savings(exc.apiName, inv.apiName)
            if savings is not None:
                direction = 'downsize' if savings > 0 else 'upsize'
            else:
                # Fallback proxy: compare the exception register's monthly cost
                # against the freshly imported instance's current monthly cost.
                direction = 'downsize' if inv.projectedCostForMonth < exc.projectedCostPerMonth else 'upsize'
            rightsized.append({
                'instanceId': exc.instanceId,
                'instanceName': exc.instanceName,
                'accountName': exc.accountName,
                'lifecycle': exc.lifecycle,
                'originalType': exc.apiName,
                'currentType': inv.apiName,
                'originalMonthlyCost': round(exc.projectedCostPerMonth, 2),
                'direction': direction,
                'estimatedSavings': savings,
            })
        else:
            active_unchanged.append({
                'instanceId': exc.instanceId,
                'instanceName': exc.instanceName,
                'accountName': exc.accountName,
                'lifecycle': exc.lifecycle,
                'product': exc.product,
                'apiName': exc.apiName,
                'monthlyCost': round(exc.projectedCostPerMonth, 2),
                'appOwner': exc.appOwner,
            })

    terminated = list(terminated_by_key.values())
    terminated.sort(key=lambda r: -r['originalMonthlyCost'])
    active_unchanged.sort(key=lambda r: -r['monthlyCost'])

    terminated_savings = round(sum(r['originalMonthlyCost'] for r in terminated), 2)
    rightsized_savings = round(sum(r['estimatedSavings'] for r in rightsized if r['estimatedSavings'] is not None), 2)
    active_cost = round(sum(r['monthlyCost'] for r in active_unchanged), 2)

    return {
        'snapshotDate': snapshot_date,
        'summary': {
            'total': len(exceptions),
            'terminated': len(terminated),
            'rightsized': len(rightsized),
            'activeUnchanged': len(active_unchanged),
            'terminatedMonthlySavings': terminated_savings,
            'rightsizedMonthlySavings': rightsized_savings,
            'activeUnchangedMonthlyCost': active_cost,
            'totalRealizedSavings': round(terminated_savings + rightsized_savings, 2),
            'duplicatesRemoved': duplicates_removed,
        },
        'terminated': terminated,
        'rightsized': rightsized,
        'activeUnchanged': active_unchanged,
    }
