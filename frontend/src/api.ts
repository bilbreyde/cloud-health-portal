import type { CommitmentContext, CostHistoryImportResult, CostHistorySummary, Customer, DashboardNarrativeResponse, ExceptionRecord, ExceptionSummary, ImportReportResponse, InventoryImportResult, InventorySnapshot, MarketplacePurchase, ReconciliationReport, Report, ReportResponse, SavingsCoverageImportResult, SavingsCoverageRecord, SpendInsightsResponse, TrendsResponse, UploadRecord, UploadResult } from './types'

const BASE = (import.meta.env.VITE_API_URL ?? '') + '/api'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

async function requestNoContent(url: string, init?: RequestInit): Promise<void> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `HTTP ${res.status}`)
  }
}

export function fetchCustomers(): Promise<Customer[]> {
  return request<Customer[]>(`${BASE}/customers`)
}

export function createCustomer(body: { name: string; slug: string }): Promise<Customer> {
  return request<Customer>(`${BASE}/customers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function updateCustomerCommitment(customerId: string, commitment: Partial<CommitmentContext>): Promise<Customer> {
  return request<Customer>(`${BASE}/customers/${customerId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(commitment),
  })
}

export function fetchTrends(
  customerId: string,
  params: { startMonth: number; startYear: number; endMonth: number; endYear: number },
): Promise<TrendsResponse> {
  const qs = new URLSearchParams({
    startMonth: String(params.startMonth),
    startYear: String(params.startYear),
    endMonth: String(params.endMonth),
    endYear: String(params.endYear),
  })
  return request<TrendsResponse>(`${BASE}/trends/${customerId}?${qs}`)
}

export function uploadCsv(formData: FormData): Promise<UploadResult> {
  return request<UploadResult>(`${BASE}/upload`, { method: 'POST', body: formData })
}

export function buildReport(body: {
  customerId: string
  month: number
  year: number
  joelNotes?: string
}): Promise<ReportResponse> {
  return request<ReportResponse>(`${BASE}/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function fetchDashboardNarrative(customerId: string, force = false): Promise<DashboardNarrativeResponse> {
  const qs = force ? '?force=true' : ''
  return request<DashboardNarrativeResponse>(`${BASE}/dashboard/${customerId}/narrative${qs}`)
}

export function patchCommitment(
  customerId: string,
  commitmentKey: string,
  checked: boolean,
): Promise<{ success: boolean; commitments: Record<string, boolean> }> {
  return request(`${BASE}/dashboard/${customerId}/narrative`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commitmentKey, checked }),
  })
}

export async function exportReport(body: {
  customerId: string
  month: number
  year: number
}): Promise<Blob> {
  const res = await fetch(`${BASE}/report/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `HTTP ${res.status}`)
  }
  return res.blob()
}

export function fetchReports(customerId: string): Promise<Report[]> {
  return request<Report[]>(`${BASE}/reports/${customerId}`)
}

export function importReport(customerId: string, formData: FormData): Promise<ImportReportResponse> {
  return request<ImportReportResponse>(`${BASE}/reports/${customerId}/import`, {
    method: 'POST',
    body: formData,
  })
}

export async function downloadReport(customerId: string, reportId: string): Promise<Blob> {
  const res = await fetch(`${BASE}/reports/${customerId}/${reportId}/download`)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `HTTP ${res.status}`)
  }
  return res.blob()
}

export function deleteEmptyDrafts(customerId: string): Promise<{ deleted: number }> {
  return request<{ deleted: number }>(`${BASE}/reports/${customerId}/drafts/empty`, {
    method: 'DELETE',
  })
}

export function fetchUploads(customerId: string): Promise<UploadRecord[]> {
  return request<UploadRecord[]>(`${BASE}/uploads/${customerId}`)
}

export function patchUpload(
  uploadId: string,
  body: { customerId: string; serviceType: string },
): Promise<UploadRecord> {
  return request<UploadRecord>(`${BASE}/upload/${uploadId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function deleteUpload(uploadId: string, customerId: string): Promise<void> {
  return requestNoContent(`${BASE}/upload/${uploadId}?customerId=${encodeURIComponent(customerId)}`, {
    method: 'DELETE',
  })
}

export function deleteTrendsForMonth(
  customerId: string,
  month: number,
  year: number,
): Promise<{ deletedCount: number; month: number; year: number }> {
  return request(`${BASE}/trends/${customerId}?month=${month}&year=${year}`, { method: 'DELETE' })
}

export function fetchExceptions(customerId: string): Promise<ExceptionRecord[]> {
  return request<ExceptionRecord[]>(`${BASE}/exceptions/${customerId}`)
}

export function fetchExceptionSummary(customerId: string): Promise<ExceptionSummary> {
  return request<ExceptionSummary>(`${BASE}/exceptions/${customerId}/summary`)
}

export function importExceptions(customerId: string, formData: FormData): Promise<{ imported: number; errors: unknown[] }> {
  return request(`${BASE}/exceptions/${customerId}/import`, { method: 'POST', body: formData })
}

export function putException(
  customerId: string,
  exceptionId: string,
  body: { notes?: string; exceptionCategory?: string },
): Promise<ExceptionRecord> {
  return request<ExceptionRecord>(`${BASE}/exceptions/${customerId}/${exceptionId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function deleteException(customerId: string, exceptionId: string): Promise<void> {
  return request<void>(`${BASE}/exceptions/${customerId}/${exceptionId}`, { method: 'DELETE' })
}

export function importCostHistory(customerId: string, formData: FormData): Promise<CostHistoryImportResult> {
  return request<CostHistoryImportResult>(`${BASE}/cost-history/${customerId}/import`, {
    method: 'POST',
    body: formData,
  })
}

export function fetchCostHistory(
  customerId: string,
  params?: { startMonth?: string; endMonth?: string },
): Promise<CostHistorySummary> {
  const qs = new URLSearchParams()
  if (params?.startMonth) qs.set('startMonth', params.startMonth)
  if (params?.endMonth) qs.set('endMonth', params.endMonth)
  const suffix = qs.toString() ? `?${qs}` : ''
  return request<CostHistorySummary>(`${BASE}/cost-history/${customerId}${suffix}`)
}

export function importSavingsCoverage(customerId: string, formData: FormData): Promise<SavingsCoverageImportResult> {
  return request<SavingsCoverageImportResult>(`${BASE}/savings-coverage/${customerId}/import`, {
    method: 'POST',
    body: formData,
  })
}

export function fetchSavingsCoverage(customerId: string, month?: string): Promise<SavingsCoverageRecord> {
  const qs = month ? `?month=${encodeURIComponent(month)}` : ''
  return request<SavingsCoverageRecord>(`${BASE}/savings-coverage/${customerId}${qs}`)
}

export function fetchSpendInsights(
  customerId: string,
  params?: { month?: string; bust?: boolean },
): Promise<SpendInsightsResponse> {
  const qs = new URLSearchParams()
  if (params?.month) qs.set('month', params.month)
  if (params?.bust) qs.set('bust', 'true')
  const suffix = qs.toString() ? `?${qs}` : ''
  return request<SpendInsightsResponse>(`${BASE}/spend-insights/${customerId}${suffix}`)
}

export function fetchMarketplacePurchases(customerId: string): Promise<MarketplacePurchase[]> {
  return request<MarketplacePurchase[]>(`${BASE}/marketplace-purchases/${customerId}`)
}

export function patchMarketplacePurchaseNote(
  customerId: string,
  month: string,
  vendorNote: string,
): Promise<MarketplacePurchase> {
  return request<MarketplacePurchase>(`${BASE}/marketplace-purchases/${customerId}/${month}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vendorNote }),
  })
}

export function importInventory(customerId: string, formData: FormData): Promise<InventoryImportResult> {
  return request<InventoryImportResult>(`${BASE}/exception-tracker/${customerId}/import-inventory`, {
    method: 'POST',
    body: formData,
  })
}

export function fetchInventorySnapshots(customerId: string): Promise<InventorySnapshot[]> {
  return request<InventorySnapshot[]>(`${BASE}/exception-tracker/${customerId}/snapshots`)
}

export function fetchReconciliation(customerId: string, snapshotDate: string): Promise<ReconciliationReport> {
  return request<ReconciliationReport>(
    `${BASE}/exception-tracker/${customerId}/reconcile?snapshotDate=${encodeURIComponent(snapshotDate)}`,
  )
}

export function saveExceptionProgressNarrative(
  customerId: string,
  month: number,
  year: number,
  narrative: string,
): Promise<{ success: boolean }> {
  return request(`${BASE}/exception-tracker/${customerId}/narrative`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ month, year, narrative }),
  })
}

export function saveSpendInsightsToReport(
  customerId: string,
  month: string,
  narrative: string,
): Promise<{ success: boolean }> {
  return request(`${BASE}/spend-insights/${customerId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ month, narrative }),
  })
}
