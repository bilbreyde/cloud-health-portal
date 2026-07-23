export type CommitmentType = 'EDP' | 'SavingsPlan' | 'EnterpriseAgreement' | 'None'

export interface CommitmentContext {
  commitmentType: CommitmentType
  commitmentAnnualValue?: number
  commitmentTermYears?: number
  commitmentStartDate?: string
  commitmentEndDate?: string
  commitmentMonthlyObligation?: number
  discountRate?: number
}

export interface Customer {
  id: string
  name: string
  slug: string
  created_at: string
  settings: Record<string, unknown> & { commitment?: CommitmentContext }
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
  aws_spend_overview?: string
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
  costSummary?: CostHistorySummary | null
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

export interface DashboardNarrative {
  situation: string
  trend: string
  exceptions: string
  recommendation: string
}

export interface DataSnapshot {
  signal: number
  exceptionFloor: number
  netAddressable: number
  realizedSavings: number
  remaining: number
  reportingMonth: number
  reportingYear: number
  prevReportLabel: string
  joelNotes: string
}

export interface DashboardNarrativeResponse {
  narrative: DashboardNarrative
  generatedAt: string
  dataSnapshot: DataSnapshot
  prevNextSteps: string[]
  commitments: Record<string, boolean>
  cached: boolean
}

export interface CostHistoryImportResult {
  success: boolean
  monthsImported: number
  servicesImported: number
  totalRows: number
  previousRowsReplaced?: number
  importedAt: string
  error?: string
}

export interface CostMonthlyTotal {
  month: string
  directCharges: number
  indirectCharges: number
  netCost: number
  isPartial: boolean
  completionRatio: number
  projectedDirectCharges: number
  projectedNetCost: number
}

export interface CostByService {
  service: string
  months: Record<string, number>
  trend: 'up' | 'down' | 'flat'
  pattern: ChargePattern
}

export interface CostTopService {
  service: string
  currentMonth: number
  previousMonth: number
  isPartial: boolean
  projectedAmount: number
  pattern: ChargePattern
  momDelta: number
  momPct: number | null
}

export interface SavingsPlanCoverage {
  covered: number
  onDemand: number
  coveragePct: number
}

export interface CostHistorySummary {
  monthlyTotals: CostMonthlyTotal[]
  byService: CostByService[]
  topServices: CostTopService[]
  savingsPlanCoverage: SavingsPlanCoverage
  projectedCurrentMonth: number
  isPartial: boolean
  completionRatio: number
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

export type AnomalyType = 'new_service' | 'statistical_anomaly' | 'spike' | 'commitment_risk'
export type ChargePattern = 'one_time' | 'recurring' | 'credit' | 'mixed'
export type ClassifierColor = 'blue' | 'yellow' | 'orange' | 'red' | 'purple' | 'gray' | 'green'

export interface SpendAnomaly {
  service: string
  currentAmount: number
  rollingAvg: number
  variance: number | null
  type: AnomalyType
  isProjected: boolean
  flagType: string
  color: ClassifierColor
  pattern: ChargePattern
  optimizationAction: string | null
  explanation: string
}

export interface CoverageRecommendation {
  term: string | null
  rationale: string
}

export interface SpendCoverageAnalysis {
  currentPct: number
  targetPct: number
  gapAmount: number
  estimatedSavings: number
  recommendation: CoverageRecommendation
}

export type TrendDirection = 'up' | 'down' | 'flat'
export type CorrelationStatus = 'executing' | 'growing' | 'alert' | 'stable' | 'monitor'

export interface SpendCorrelation {
  service: string
  spendTrend: TrendDirection
  signalTrend: TrendDirection
  interpretation: string
  status: CorrelationStatus
}

export type OpportunityPriority = 'Critical' | 'High' | 'Medium' | 'Low'

export interface SpendOpportunity {
  category: string
  service: string
  currentCost: number
  estimatedSavings: number
  priority: OpportunityPriority
  action: string
}

export interface ExcludedService {
  service: string
  amount: number
  reason: string
}

export interface SpendCommitmentUtilization {
  commitmentType: CommitmentType | null
  monthlyObligation: number
  actualSpend: number
  projectedSpend: number
  isPartial: boolean
  completionRatio: number
  recurringSpend: number
  oneTimeCharges: number
  credits: number
  netBilled: number
  excludedServices: ExcludedService[]
  utilizationPct: number | null
  onTrack: boolean
  overUnderAmount: number | null
  trailing3MoAvg: number | null
  underUtilizationRisk: boolean
  monthsRemaining: number | null
  expiryWarning: boolean
  commitmentEndDate: string | null
  commitmentAnnualValue?: number
  commitmentTermYears?: number
  discountRate?: number
}

export interface SpendInsightsResponse {
  anomalies: SpendAnomaly[]
  coverageAnalysis: SpendCoverageAnalysis | null
  commitmentUtilization: SpendCommitmentUtilization | null
  correlations: SpendCorrelation[]
  opportunities: SpendOpportunity[]
  narrative: string
  month: string
  totalSpend: number
  actualSpendToDate: number
  momChange: number
  momPct: number | null
  isPartial: boolean
  completionRatio: number
  generatedAt: string
  cached: boolean
}
