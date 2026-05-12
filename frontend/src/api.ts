import type { Customer, ExceptionRecord, ExceptionSummary, ImportReportResponse, Report, ReportResponse, TrendsResponse, UploadRecord, UploadResult } from './types'

const BASE = (import.meta.env.VITE_API_URL ?? '') + '/api'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export function fetchCustomers(): Promise<Customer[]> {
  return request<Customer[]>(`${BASE}/customers`)
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

export function fetchReports(customerId: string): Promise<Report[]> {
  return request<Report[]>(`${BASE}/reports/${customerId}`)
}

export function importReport(customerId: string, formData: FormData): Promise<ImportReportResponse> {
  return request<ImportReportResponse>(`${BASE}/reports/${customerId}/import`, {
    method: 'POST',
    body: formData,
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
