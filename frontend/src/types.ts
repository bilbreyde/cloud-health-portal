export interface Customer {
  id: string
  name: string
  slug: string
  created_at: string
  settings: Record<string, unknown>
}

export interface MonthlyTotal {
  month: number
  year: number
  total: number
  byService: Record<string, number>
}

export interface Mover {
  serviceType: string
  momDelta: number
  direction: string
}

export interface ServiceRow {
  serviceType: string
  savingsTotal?: number
  momDelta: number
  direction: string
  classification?: string
  jan?: number | null
  feb?: number | null
  mar?: number | null
  apr?: number | null
  may?: number | null
  jun?: number | null
  jul?: number | null
  aug?: number | null
  sep?: number | null
  oct?: number | null
  nov?: number | null
  dec?: number | null
}

export interface SnapshotDetail {
  serviceType: string
  year: number
  month: number
  snapshotDate: string
  snapshotNumber: number
  savingsTotal: number
  rowCount: number
}

export interface TrendsResponse {
  customerId: string
  monthly_totals: MonthlyTotal[]
  top_movers_up: Mover[]
  top_movers_down: Mover[]
  service_summary: ServiceRow[]
  snapshots_detail: SnapshotDetail[]
}

export interface UploadResult {
  success: boolean
  uploadId: string
  serviceType: string
  savingsTotal: number
  rowCount: number
  snapshotDate?: string
  snapshotNumber?: number
  error?: string
}

export interface NarrativeDraft {
  executive_summary: string
  optimization_narrative: string
  top_movers_analysis: string
  risks_and_next_steps: string
  exception_delta?: string
}

export interface ReportResponse {
  success: boolean
  reportId: string
  narrativeDraft: NarrativeDraft
  topMoversUp: Mover[]
  topMoversDown: Mover[]
  serviceSummary: Array<{
    serviceType: string
    savingsTotal: number
    momDelta: number
    direction: string
    classification: string
  }>
  totalExceptionCost: number
  topExceptionCategories: { category: string; count: number; monthlyCost: number }[]
  totalSignal: number
  realizedSavings: number
  exceptionFloor: number
}

export interface ExtractedReportData {
  monthlySavings: Record<string, number>
  topMoversUp: { serviceType: string; amount: number }[]
  topMoversDown: { serviceType: string; amount: number }[]
  realizedSavings: number
  exceptionFloor: number
  nextSteps: string[]
}

export interface ImportReportResponse {
  success: boolean
  reportId: string
  extractedData: ExtractedReportData
}

export interface UploadRecord {
  id: string
  customerId: string
  month: number
  year: number
  serviceType: string
  fileName: string
  blobPath: string
  uploadedAt: string
  status: string
  snapshotDate: string
  savingsTotal: number
  snapshotNumber: number
  isRelabeled: boolean
}

export interface ExceptionRecord {
  id: string
  customerId: string
  instanceId: string
  instanceName: string
  accountName: string
  appOwner: string
  product: string
  lifecycle: string
  notes: string
  pricePerHour: number
  projectedCostPerMonth: number
  state: string
  apiName: string
  serverRole: string
  portfolioName: string
  exceptionCategory: string
  createdAt: string
  updatedAt: string
}

export interface ExceptionSummary {
  totalCount: number
  totalMonthlyCost: number
  byCategory: { category: string; count: number; monthlyCost: number }[]
  byLifecycle: { lifecycle: string; count: number; monthlyCost: number }[]
}

export interface Report {
  id: string
  customerId: string
  month: number
  year: number
  status: string
  blobPath: string
  generatedAt: string
  joelNotes?: string
  narrativeDraft?: string
  source?: string
  extractedData?: ExtractedReportData
}
