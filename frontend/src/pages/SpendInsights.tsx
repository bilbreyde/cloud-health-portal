import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts'
import { fetchSpendInsights, saveSpendInsightsToReport } from '../api'
import { useCustomer } from '../context/CustomerContext'
import type { AnomalyType, CorrelationStatus, OpportunityPriority, SpendInsightsResponse } from '../types'

// Validated categorical palette (dataviz skill), consistent with Dashboard's cost widgets.
const COVERED_COLOR = '#2a78d6'
const TRACK_COLOR = 'var(--border)'

function fmtMoney(n: number) {
  return '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function fmtMonthLabel(m: string) {
  const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const [y, mo] = m.split('-').map(Number)
  return `${MONTH_ABBR[(mo || 1) - 1]} ${y}`
}
function timeAgo(isoStr: string): string {
  const mins = Math.floor((Date.now() - new Date(isoStr).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  return `${Math.floor(mins / 60)}h ago`
}
function now() { const d = new Date(); return { month: d.getMonth() + 1, year: d.getFullYear() } }

const ANOMALY_SEVERITY: Record<AnomalyType, 'red' | 'yellow'> = {
  new_service: 'red',
  statistical_anomaly: 'yellow',
  spike: 'yellow',
}
function anomalySeverity(type: AnomalyType, variance: number | null): 'red' | 'yellow' {
  if (type === 'new_service') return 'red'
  if (type === 'spike' && variance !== null && variance > 100) return 'red'
  return ANOMALY_SEVERITY[type]
}
const ANOMALY_TYPE_LABEL: Record<AnomalyType, string> = {
  new_service: 'New Service',
  statistical_anomaly: 'Statistical Anomaly',
  spike: 'Spike',
}

const STATUS_BADGE: Record<CorrelationStatus, { label: string; cls: string }> = {
  executing: { label: 'Executing', cls: 'badge-green' },
  growing: { label: 'Growing', cls: 'badge-yellow' },
  alert: { label: 'Alert', cls: 'badge-red' },
  stable: { label: 'Stable', cls: 'badge-gray' },
  monitor: { label: 'Monitor', cls: 'badge-gray' },
}

const PRIORITY_BADGE: Record<OpportunityPriority, string> = {
  High: 'badge-red',
  Medium: 'badge-yellow',
  Low: 'badge-gray',
}

const TREND_ARROW: Record<string, string> = { up: '▲', down: '▼', flat: '—' }

function CoverageDonut({ currentPct, targetPct }: { currentPct: number; targetPct: number }) {
  const data = [
    { name: 'Covered', value: currentPct },
    { name: 'Remaining', value: Math.max(0, 100 - currentPct) },
  ]
  return (
    <div style={{ position: 'relative', width: '100%', height: 200 }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            innerRadius="68%"
            outerRadius="90%"
            startAngle={90}
            endAngle={-270}
            stroke="none"
          >
            <Cell fill={COVERED_COLOR} />
            <Cell fill={TRACK_COLOR} />
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
      }}>
        <div style={{ fontSize: 30, fontWeight: 700, color: COVERED_COLOR }}>{currentPct.toFixed(1)}%</div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>Target: {targetPct.toFixed(0)}%</div>
      </div>
    </div>
  )
}

// Green 90-110%, yellow 80-90% or 110-120%, red <80% or >120%.
function utilizationColor(pct: number): string {
  if (pct >= 90 && pct <= 110) return 'var(--green)'
  if ((pct >= 80 && pct < 90) || (pct > 110 && pct <= 120)) return '#9D5D00'
  return 'var(--red)'
}

function CommitmentGauge({ utilizationPct }: { utilizationPct: number }) {
  const color = utilizationColor(utilizationPct)
  const filled = Math.min(100, Math.max(0, utilizationPct))
  const data = [
    { name: 'Utilized', value: filled },
    { name: 'Remaining', value: Math.max(0, 100 - filled) },
  ]
  return (
    <div style={{ position: 'relative', width: '100%', height: 200 }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            innerRadius="68%"
            outerRadius="90%"
            startAngle={90}
            endAngle={-270}
            stroke="none"
          >
            <Cell fill={color} />
            <Cell fill={TRACK_COLOR} />
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
      }}>
        <div style={{ fontSize: 30, fontWeight: 700, color }}>{utilizationPct.toFixed(1)}%</div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>of monthly obligation</div>
      </div>
    </div>
  )
}

function AnomalyCard({
  service, currentAmount, type, explanation, variance,
}: { service: string; currentAmount: number; type: AnomalyType; explanation: string; variance: number | null }) {
  const severity = anomalySeverity(type, variance)
  const bg = severity === 'red' ? '#FDE7E9' : '#FFF4CE'
  const border = severity === 'red' ? '#F4B8BD' : '#F5DFA0'
  const badgeCls = severity === 'red' ? 'badge-red' : 'badge-yellow'
  return (
    <div style={{
      padding: '14px 16px', background: bg, border: `1px solid ${border}`, borderRadius: 8,
      display: 'flex', flexDirection: 'column', gap: 6, minWidth: 260, flex: '1 1 300px',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{service}</div>
        <span className={`badge ${badgeCls}`}>{ANOMALY_TYPE_LABEL[type]}</span>
      </div>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{fmtMoney(currentAmount)}</div>
      <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text)' }}>{explanation}</div>
      <Link to="/" style={{ fontSize: 12, marginTop: 2 }}>View in Cost History →</Link>
    </div>
  )
}

function OpportunityCard({
  category, service, currentCost, estimatedSavings, priority, action,
}: { category: string; service: string; currentCost: number; estimatedSavings: number; priority: OpportunityPriority; action: string }) {
  return (
    <div className="card" style={{ marginBottom: 0, flex: '1 1 280px', minWidth: 260 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px' }}>{category}</div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{service}</div>
        </div>
        <span className={`badge ${PRIORITY_BADGE[priority]}`}>{priority}</span>
      </div>
      <div style={{ display: 'flex', gap: 20, marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 10, color: 'var(--muted)' }}>Current Cost</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{fmtMoney(currentCost)}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: 'var(--muted)' }}>Est. Savings/mo</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--green)' }}>{fmtMoney(estimatedSavings)}</div>
        </div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.5, marginBottom: 10 }}>{action}</div>
      <Link to="/upload" className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px', display: 'inline-block' }}>
        Review in Cost History
      </Link>
    </div>
  )
}

export default function SpendInsights() {
  const today = now()
  const { selectedCustomer } = useCustomer()
  const customerId = selectedCustomer?.id ?? ''
  const monthKey = `${today.year}-${String(today.month).padStart(2, '0')}`

  const [insights, setInsights] = useState<SpendInsightsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [copyLabel, setCopyLabel] = useState('Copy to Clipboard')
  const [savingToReport, setSavingToReport] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')

  function load(bust: boolean) {
    if (!customerId) return
    setLoading(true)
    setError('')
    fetchSpendInsights(customerId, { month: monthKey, bust })
      .then(setInsights)
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (!customerId) { setInsights(null); return }
    load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId])

  async function copyNarrative() {
    if (!insights?.narrative) return
    try {
      await navigator.clipboard.writeText(insights.narrative)
      setCopyLabel('Copied!')
      setTimeout(() => setCopyLabel('Copy to Clipboard'), 1500)
    } catch {
      setCopyLabel('Copy failed')
      setTimeout(() => setCopyLabel('Copy to Clipboard'), 1500)
    }
  }

  async function addToReport() {
    if (!customerId || !insights) return
    setSavingToReport(true)
    setSaveMsg('')
    try {
      await saveSpendInsightsToReport(customerId, insights.month, insights.narrative)
      setSaveMsg('Added to this month’s report')
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingToReport(false)
      setTimeout(() => setSaveMsg(''), 4000)
    }
  }

  const cov = insights?.coverageAnalysis
  const cu = insights?.commitmentUtilization
  const opportunities = insights?.opportunities ?? []

  return (
    <main className="page">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <h1 className="page-title" style={{ margin: 0 }}>
          AI Spend Insights <span className="badge badge-blue" style={{ fontSize: 10, marginLeft: 8 }}>AI</span>
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {insights && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{timeAgo(insights.generatedAt)}{insights.cached ? ' · cached' : ''}</span>}
          <button className="btn btn-primary" onClick={() => load(true)} disabled={!customerId || loading}>
            {loading ? <><span className="spinner" /> Analyzing…</> : '↻ Refresh Analysis'}
          </button>
        </div>
      </div>

      {!customerId && (
        <div className="card" style={{ textAlign: 'center', padding: '48px 20px' }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>No customer selected</div>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>Choose a customer from the selector in the top navigation bar.</div>
        </div>
      )}

      {customerId && error && (
        <div className="alert alert-error" style={{ marginTop: 16 }}>{error}</div>
      )}

      {customerId && loading && !insights && (
        <div className="card" style={{ textAlign: 'center', padding: '48px 20px' }}>
          <span className="spinner" style={{ borderTopColor: 'var(--blue)', width: 20, height: 20 }} />
          <div style={{ marginTop: 12, color: 'var(--muted)', fontSize: 13 }}>Running spend analysis…</div>
        </div>
      )}

      {customerId && !loading && !insights && !error && (
        <div className="card" style={{ textAlign: 'center', padding: '48px 20px' }}>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>
            No AWS Cost History imported yet.{' '}
            <Link to="/upload">Import a CostHistory CSV</Link> to run spend insights.
          </div>
        </div>
      )}

      {insights && (
        <>
          {/* ── SECTION 1: Anomalies Detected ─────────────────────────────── */}
          <div className="card">
            <div className="card-title">Anomalies Detected — {fmtMonthLabel(insights.month)}</div>
            {insights.anomalies.length === 0 ? (
              <p style={{ color: 'var(--muted)', fontSize: 13 }}>No statistically significant anomalies this period.</p>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                {insights.anomalies.map(a => (
                  <AnomalyCard key={a.service} {...a} />
                ))}
              </div>
            )}
          </div>

          {/* ── SECTION 2: Commitment Utilization (large-commitment customers) ── */}
          {cu && cu.utilizationPct !== null && (
            <div className="card">
              <div className="card-title">Commitment Utilization</div>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ flex: '1 1 220px', maxWidth: 260 }}>
                  <CommitmentGauge utilizationPct={cu.utilizationPct} />
                </div>
                <div style={{ flex: '2 1 320px' }}>
                  <div style={{ display: 'flex', gap: 20, marginBottom: 12, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px' }}>Monthly Obligation</div>
                      <div style={{ fontSize: 16, fontWeight: 700 }}>{fmtMoney(cu.monthlyObligation)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px' }}>Actual Spend</div>
                      <div style={{ fontSize: 16, fontWeight: 700 }}>{fmtMoney(cu.actualSpend)}</div>
                    </div>
                  </div>

                  {cu.overUnderAmount !== null && (
                    <div style={{
                      padding: '12px 14px', background: 'var(--bg)', borderRadius: 6,
                      border: '1px solid var(--border)', marginBottom: 12, fontSize: 13, lineHeight: 1.6,
                    }}>
                      <strong style={{ color: cu.overUnderAmount < 0 ? 'var(--green)' : 'var(--red)' }}>
                        {cu.overUnderAmount < 0 ? '−' : '+'}{fmtMoney(cu.overUnderAmount)}
                      </strong>{' '}
                      {cu.overUnderAmount < 0 ? 'under' : 'over'} obligation this month.{' '}
                      {cu.trailing3MoAvg !== null && (
                        <>Trailing 3-month average: <strong>{fmtMoney(cu.trailing3MoAvg)}</strong> — {cu.underUtilizationRisk ? 'at risk' : 'on track'}.</>
                      )}
                    </div>
                  )}

                  {cu.monthsRemaining !== null && (
                    <div style={{
                      padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 6,
                      borderLeft: `3px solid ${cu.expiryWarning ? 'var(--red)' : 'var(--blue)'}`, marginBottom: 12,
                    }}>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>
                        Commitment expires in {cu.monthsRemaining} month{cu.monthsRemaining !== 1 ? 's' : ''}
                        {cu.commitmentEndDate ? ` (${fmtMonthLabel(cu.commitmentEndDate.slice(0, 7))})` : ''}
                      </div>
                      {cu.expiryWarning && (
                        <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 4 }}>
                          Renewal decision needed — current pricing vs. market rate analysis recommended.
                        </div>
                      )}
                    </div>
                  )}

                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {cu.commitmentType} commitment{cu.discountRate ? ` · ~${(cu.discountRate * 100).toFixed(0)}% discount vs. on-demand` : ''}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── SECTION 2 (alt): Savings Plan Optimization ────────────────── */}
          {!cu && cov && (
            <div className="card">
              <div className="card-title">Savings Plan Optimization</div>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ flex: '1 1 220px', maxWidth: 260 }}>
                  <CoverageDonut currentPct={cov.currentPct} targetPct={cov.targetPct} />
                </div>
                <div style={{ flex: '2 1 320px' }}>
                  <div style={{
                    padding: '12px 14px', background: 'var(--bg)', borderRadius: 6,
                    border: '1px solid var(--border)', marginBottom: 12, fontSize: 13, lineHeight: 1.6,
                  }}>
                    Increasing coverage from <strong>{cov.currentPct.toFixed(1)}%</strong> to{' '}
                    <strong>{cov.targetPct.toFixed(0)}%</strong> could save{' '}
                    <strong style={{ color: 'var(--green)' }}>~{fmtMoney(cov.estimatedSavings)}/month</strong>{' '}
                    (~{fmtMoney(cov.gapAmount)} of on-demand spend would need to shift to committed usage).
                  </div>
                  {cov.recommendation.term && (
                    <div style={{
                      padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 6,
                      borderLeft: '3px solid var(--blue)', marginBottom: 12,
                    }}>
                      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--blue)', marginBottom: 4 }}>
                        Recommended: {cov.recommendation.term} Commitment
                      </div>
                      <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text)' }}>{cov.recommendation.rationale}</div>
                    </div>
                  )}
                  <a
                    href="https://console.aws.amazon.com/cost-management/home#/savings-plans/purchase"
                    target="_blank" rel="noreferrer"
                    className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 12px' }}
                  >
                    Open AWS Cost Explorer — Savings Plans ↗
                  </a>
                </div>
              </div>
            </div>
          )}

          {/* ── SECTION 3: Signal vs Spend Correlation ────────────────────── */}
          <div className="card">
            <div className="card-title">Signal vs Spend Correlation</div>
            {insights.correlations.length === 0 ? (
              <p style={{ color: 'var(--muted)', fontSize: 13 }}>Not enough comparable signal/spend history yet.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Service</th><th>Spend Trend</th><th>Signal Trend</th><th>Interpretation</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {insights.correlations.map(c => {
                      const badge = STATUS_BADGE[c.status]
                      return (
                        <tr key={c.service}>
                          <td style={{ fontWeight: 600 }}>{c.service}</td>
                          <td className={c.spendTrend === 'up' ? 'up' : c.spendTrend === 'down' ? 'down' : 'flat'}>
                            {TREND_ARROW[c.spendTrend]} {c.spendTrend}
                          </td>
                          <td className={c.signalTrend === 'up' ? 'up' : c.signalTrend === 'down' ? 'down' : 'flat'}>
                            {TREND_ARROW[c.signalTrend]} {c.signalTrend}
                          </td>
                          <td style={{ fontSize: 12 }}>{c.interpretation}</td>
                          <td><span className={`badge ${badge.cls}`}>{badge.label}</span></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── SECTION 4: Additional Opportunities ───────────────────────── */}
          <div className="card">
            <div className="card-title">Additional Opportunities</div>
            {opportunities.length === 0 ? (
              <p style={{ color: 'var(--muted)', fontSize: 13 }}>No additional opportunities identified beyond CloudHealth signal.</p>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
                {opportunities.map(o => (
                  <OpportunityCard key={`${o.category}-${o.service}`} {...o} />
                ))}
              </div>
            )}
          </div>

          {/* ── SECTION 5: AI Narrative ────────────────────────────────────── */}
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="card-title" style={{ margin: 0 }}>AI Narrative</span>
                <span className="badge badge-blue" style={{ fontSize: 9, padding: '1px 6px' }}>AI</span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-ghost" onClick={copyNarrative} style={{ fontSize: 12, padding: '4px 10px' }}>
                  {copyLabel}
                </button>
                <button className="btn btn-primary" onClick={addToReport} disabled={savingToReport} style={{ fontSize: 12, padding: '4px 10px' }}>
                  {savingToReport ? <><span className="spinner" /> Saving…</> : 'Add to Report'}
                </button>
              </div>
            </div>
            {saveMsg && (
              <div style={{ fontSize: 12, color: saveMsg.startsWith('Added') ? 'var(--green)' : 'var(--red)', marginBottom: 10 }}>
                {saveMsg}
              </div>
            )}
            <div style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text)', whiteSpace: 'pre-wrap' }}>
              {insights.narrative || 'No narrative generated.'}
            </div>
          </div>
        </>
      )}
    </main>
  )
}
