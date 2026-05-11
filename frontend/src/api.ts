import type { Customer, Report, ReportResponse, TrendsResponse, UploadResult } from './types'

const BASE = '/api'

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
