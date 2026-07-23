import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { buildReport, fetchSpendInsights, saveSpendInsightsToReport } from '../api'
import { useCustomer } from '../context/CustomerContext'
import type { NarrativeDraft, ReportResponse, SpendInsightsResponse } from '../types'

const MONTH_NAMES = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December']
const MONTH_ABBR  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const NARRATIVE_FIELDS: { key: keyof NarrativeDraft; label: string }[] = [
  { key: 'executive_summary',      label: 'Executive Summary'      },
  { key: 'optimization_narrative', label: 'Optimization Narrative' },
  { key: 'top_movers_analysis',    label: 'Top Movers Analysis'    },
  { key: 'risks_and_next_steps',   label: 'Risks & Next Steps'     },
]

function fmtMoney(n: number) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function FlowStat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={{ textAlign: 'center', minWidth: 120 }}>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.4px' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: accent ?? 'var(--text)' }}>{value}</div>
    </div>
  )
}

function FlowArrow({ label, color }: { label: string; color: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', color, fontSize: 11, fontWeight: 600 }}>
      <span style={{ fontSize: 16 }}>→</span>
      <span style={{ whiteSpace: 'nowrap' }}>{label}</span>
    </div>
  )
}

function now() { const d = new Date(); return { month: d.getMonth() + 1, year: d.getFullYear() } }

export default function ReportBuilder() {
  const today = now()
  const { selectedCustomer } = useCustomer()
  const customerId = selectedCustomer?.id ?? ''
  const [month, setMonth]             = useState(today.month)
  const [year, setYear]               = useState(2026)
  const [joelNotes, setJoelNotes]     = useState('')
  const [report, setReport]           = useState<ReportResponse | null>(null)
  const [draft, setDraft]             = useState<NarrativeDraft | null>(null)
  const [generating, setGenerating]   = useState(false)
  const [exporting, setExporting]     = useState(false)
  const [exportMsg, setExportMsg]     = useState('')
  const [error, setError]             = useState('')

  const [spendInsights, setSpendInsights]             = useState<SpendInsightsResponse | null>(null)
  const [spendInsightsLoading, setSpendInsightsLoading] = useState(false)
  const [spendInsightsDraft, setSpendInsightsDraft]     = useState('')
  const [spendInsightsSaving, setSpendInsightsSaving]   = useState(false)
  const [spendInsightsSaveMsg, setSpendInsightsSaveMsg] = useState('')

  useEffect(() => {
    if (!customerId) { setSpendInsights(null); return }
    const monthKey = `${year}-${String(month).padStart(2, '0')}`
    setSpendInsightsLoading(true)
    fetchSpendInsights(customerId, { month: monthKey })
      .then(res => { setSpendInsights(res); setSpendInsightsDraft(res.narrative) })
      .catch(() => setSpendInsights(null))
      .finally(() => setSpendInsightsLoading(false))
  }, [customerId, month, year])

  async function saveSpendInsights() {
    if (!customerId || !spendInsights) return
    setSpendInsightsSaving(true)
    setSpendInsightsSaveMsg('')
    try {
      await saveSpendInsightsToReport(customerId, spendInsights.month, spendInsightsDraft)
      setSpendInsightsSaveMsg('Saved to report')
    } catch (e) {
      setSpendInsightsSaveMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setSpendInsightsSaving(false)
      setTimeout(() => setSpendInsightsSaveMsg(''), 4000)
    }
  }

  async function generate() {
    if (!customerId) return
    setGenerating(true)
    setError('')
    try {
      const res = await buildReport({ customerId, month, year, joelNotes: joelNotes || undefined })
      setReport(res)
      setDraft({ ...res.narrativeDraft })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setGenerating(false)
    }
  }

  async function handleExport() {
    if (!customerId) return
    setExporting(true)
    setExportMsg('')
    const apiUrl = (import.meta.env.VITE_API_URL ?? '') + '/api/report/export'
    console.log('[export] POST', apiUrl, { customerId, month, year })
    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId, month, year }),
      })
      console.log('[export] status', response.status, 'content-type', response.headers.get('Content-Type'))
      if (!response.ok) {
        const text = await response.text()
        console.error('[export] error body', text)
        throw new Error(text || `HTTP ${response.status}`)
      }
      const blob = await response.blob()
      console.log('[export] blob size', blob.size, 'type', blob.type)
      if (blob.size === 0) throw new Error('Received empty file from server')
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${selectedCustomer?.slug ?? customerId}_${year}_${String(month).padStart(2, '0')}_report.docx`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setExportMsg('Downloaded successfully')
    } catch (e) {
      console.error('[export] caught', e)
      setExportMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setExporting(false)
    }
  }

  function updateDraft(key: keyof NarrativeDraft, value: string) {
    setDraft(prev => prev ? { ...prev, [key]: value } : prev)
  }

  const dirClass = (d: string) => d === 'Up' ? 'up' : d === 'Down' ? 'down' : 'flat'
  const dirArrow = (d: string) => d === 'Up' ? '▲' : d === 'Down' ? '▼' : '—'

  // Delta section derived values
  const totalSignal     = report?.totalSignal ?? 0
  const exceptionFloor  = report?.exceptionFloor ?? 0
  const realizedSavings = report?.realizedSavings ?? 0
  const netAddressable  = Math.max(0, totalSignal - exceptionFloor)
  const remaining       = Math.max(0, netAddressable - realizedSavings)

  // AWS Spend Overview derived values
  const costTotals = report?.costSummary?.monthlyTotals ?? []
  const costCurrent = costTotals[costTotals.length - 1]
  const costPrevious = costTotals[costTotals.length - 2]
  const costMomDelta = costCurrent && costPrevious ? costCurrent.directCharges - costPrevious.directCharges : null

  return (
    <main className="page">
      <h1 className="page-title">Report Builder</h1>

      <div className="card">
        <div className="controls">
          <div className="field">
            <label>Month</label>
            <select value={month} onChange={e => setMonth(+e.target.value)}>
              {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Year</label>
            <select value={year} onChange={e => setYear(+e.target.value)}>
              {[2026, 2027, 2028].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <button className="btn btn-primary" onClick={generate} disabled={!customerId || generating}>
            {generating ? <><span className="spinner" /> Generating…</> : 'Generate Report'}
          </button>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
      </div>

      <div className="card">
        <div className="card-title">Export Report</div>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 12px' }}>
          Export the most recently generated report for this customer and period as a formatted .docx document.
          A report must have been generated at least once before exporting.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            className="btn btn-primary"
            onClick={handleExport}
            disabled={!customerId || exporting}
          >
            {exporting
              ? <><span className="spinner" /> Exporting…</>
              : 'Export .docx'}
          </button>
          {exportMsg && (
            <span style={{
              fontSize: 12,
              color: exportMsg === 'Downloaded successfully' ? 'var(--green)' : 'var(--red)',
            }}>
              {exportMsg}
            </span>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-title">Joel's Notes</div>
        <textarea
          value={joelNotes}
          onChange={e => setJoelNotes(e.target.value)}
          placeholder="Paste engagement manager notes, observations, or context to incorporate into the narrative…"
          style={{ width: '100%' }}
        />
        {report && (
          <div style={{ marginTop: 12 }}>
            <button className="btn btn-secondary" onClick={generate} disabled={generating}>
              {generating ? <><span className="spinner" style={{ borderTopColor: 'var(--blue)' }} /> Regenerating…</> : 'Regenerate with Notes'}
            </button>
          </div>
        )}
      </div>

      {report && draft && (
        <>
          <div className="card">
            <div className="card-title">
              AI-Generated Narrative — {MONTH_ABBR[month - 1]} {year}
              {' '}<span className="badge badge-yellow" style={{ marginLeft: 8 }}>Draft</span>
            </div>
            {NARRATIVE_FIELDS.map(({ key, label }) => (
              <div key={key} className="narrative-section">
                <div className="narrative-label">{label}</div>
                <textarea
                  value={draft[key] ?? ''}
                  onChange={e => updateDraft(key, e.target.value)}
                  style={{ width: '100%', minHeight: key === 'executive_summary' ? 180 : 140 }}
                />
              </div>
            ))}
          </div>

          {/* Exception & Signal Delta section */}
          <div className="card">
            <div className="card-title">Exception & Signal Delta</div>

            {/* Visual flow: Signal → Exception Floor → Net → Realized → Remaining */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
              padding: '16px 0', marginBottom: 16, borderBottom: '1px solid var(--border)',
            }}>
              <FlowStat label="CloudHealth Signal" value={fmtMoney(totalSignal)} accent="var(--text)" />
              <FlowArrow label="− Exception Floor" color="var(--red)" />
              <FlowStat label="Exception Floor" value={fmtMoney(exceptionFloor)} accent="var(--red)" />
              <FlowArrow label="= Net Addressable" color="var(--muted)" />
              <FlowStat label="Net Addressable" value={fmtMoney(netAddressable)} accent="var(--blue)" />
              {realizedSavings > 0 && (
                <>
                  <FlowArrow label="− Realized" color="var(--green)" />
                  <FlowStat label="Realized Savings" value={fmtMoney(realizedSavings)} accent="var(--green)" />
                  <FlowArrow label="= Remaining" color="var(--muted)" />
                  <FlowStat label="Remaining Opportunity" value={fmtMoney(remaining)} accent="var(--blue-dark)" />
                </>
              )}
            </div>

            <div className="narrative-section" style={{ margin: 0 }}>
              <div className="narrative-label">Exception & Signal Delta Narrative</div>
              <textarea
                value={draft.exception_delta ?? ''}
                onChange={e => updateDraft('exception_delta', e.target.value)}
                style={{ width: '100%', minHeight: 160 }}
                placeholder="Auto-generated when report is built…"
              />
            </div>
          </div>

          {/* AWS Spend Overview section */}
          {report.costSummary && (
            <div className="card">
              <div className="card-title">AWS Spend Overview</div>

              <div style={{
                display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap',
                padding: '10px 0 16px', marginBottom: 16, borderBottom: '1px solid var(--border)',
              }}>
                <FlowStat label="Current Month" value={costCurrent ? fmtMoney(costCurrent.directCharges) : '—'} />
                <FlowStat label="Last Month" value={costPrevious ? fmtMoney(costPrevious.directCharges) : '—'} />
                <FlowStat
                  label="MoM Change"
                  value={costMomDelta !== null ? `${costMomDelta >= 0 ? '+' : ''}${fmtMoney(costMomDelta)}` : '—'}
                  accent={costMomDelta !== null ? (costMomDelta > 0 ? 'var(--red)' : 'var(--green)') : undefined}
                />
                <FlowStat
                  label="Savings Plan Coverage"
                  value={`${report.costSummary.savingsPlanCoverage.coveragePct.toFixed(1)}%`}
                  accent="var(--blue)"
                />
              </div>

              <div className="table-wrap">
                <table>
                  <thead><tr><th>Service</th><th>Current Month</th><th>Last Month</th><th>MoM Delta</th></tr></thead>
                  <tbody>
                    {report.costSummary.topServices.map(s => (
                      <tr key={s.service}>
                        <td style={{ fontWeight: 600 }}>{s.service}</td>
                        <td>{fmtMoney(s.currentMonth)}</td>
                        <td>{fmtMoney(s.previousMonth)}</td>
                        <td>
                          <span className={s.momDelta > 0.5 ? 'up' : s.momDelta < -0.5 ? 'down' : 'flat'}>
                            {s.momDelta > 0.5 ? '▲' : s.momDelta < -0.5 ? '▼' : '—'} {fmtMoney(Math.abs(s.momDelta))}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="narrative-section" style={{ margin: '16px 0 0' }}>
                <div className="narrative-label">AWS Spend Overview Narrative</div>
                <textarea
                  value={draft.aws_spend_overview ?? ''}
                  onChange={e => updateDraft('aws_spend_overview', e.target.value)}
                  style={{ width: '100%', minHeight: 140 }}
                  placeholder="Auto-generated when report is built…"
                />
              </div>
            </div>
          )}

          {/* Spend Insights section */}
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div className="card-title" style={{ margin: 0 }}>
                Spend Insights <span className="badge badge-blue" style={{ fontSize: 9, marginLeft: 6 }}>AI</span>
              </div>
              {spendInsightsLoading && <span className="spinner" style={{ borderTopColor: 'var(--blue)', width: 12, height: 12 }} />}
            </div>

            {!spendInsightsLoading && !spendInsights && (
              <p style={{ color: 'var(--muted)', fontSize: 13 }}>
                No spend insights available for {MONTH_ABBR[month - 1]} {year} yet.{' '}
                <Link to="/spend-insights">Run the analysis</Link> on the Spend Insights page first.
              </p>
            )}

            {spendInsights && (
              <>
                {spendInsights.anomalies.length > 0 && (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6 }}>
                      Anomalies ({spendInsights.anomalies.length})
                    </div>
                    {spendInsights.anomalies.slice(0, 5).map(a => (
                      <div key={a.service} style={{ fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                        <strong>{a.service}</strong> — {fmtMoney(a.currentAmount)} ({a.type.replace('_', ' ')})
                      </div>
                    ))}
                  </div>
                )}

                {spendInsights.opportunities.length > 0 && (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6 }}>
                      Opportunities ({spendInsights.opportunities.length})
                    </div>
                    {spendInsights.opportunities.slice(0, 5).map(o => (
                      <div key={`${o.category}-${o.service}`} style={{ fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                        [{o.priority}] <strong>{o.service}</strong> — est. {fmtMoney(o.estimatedSavings)}/mo — {o.action}
                      </div>
                    ))}
                  </div>
                )}

                <div className="narrative-section" style={{ margin: 0 }}>
                  <div className="narrative-label">Spend Insights Narrative</div>
                  <textarea
                    value={spendInsightsDraft}
                    onChange={e => setSpendInsightsDraft(e.target.value)}
                    style={{ width: '100%', minHeight: 140 }}
                    placeholder="Auto-generated from spend insights analysis…"
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                  <button className="btn btn-secondary" onClick={saveSpendInsights} disabled={spendInsightsSaving}>
                    {spendInsightsSaving ? <><span className="spinner" /> Saving…</> : 'Save to Report'}
                  </button>
                  {spendInsightsSaveMsg && (
                    <span style={{ fontSize: 12, color: spendInsightsSaveMsg === 'Saved to report' ? 'var(--green)' : 'var(--red)' }}>
                      {spendInsightsSaveMsg}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="grid-2">
            <div className="card">
              <div className="card-title">Top Movers — Up</div>
              {report.topMoversUp.length === 0
                ? <p style={{ color: 'var(--muted)', fontSize: 13 }}>None</p>
                : (
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Service</th><th>MoM Delta</th><th>Classification</th></tr></thead>
                      <tbody>
                        {report.topMoversUp.map(m => {
                          const cls = report.serviceSummary.find(s => s.serviceType === m.serviceType)?.classification ?? ''
                          return (
                            <tr key={m.serviceType}>
                              <td>{m.serviceType}</td>
                              <td><span className="up">▲ ${m.momDelta.toLocaleString()}</span></td>
                              <td>
                                {cls === 'Persistent Issue' && <span className="badge badge-red">{cls}</span>}
                                {cls === 'New Insight' && <span className="badge badge-yellow">{cls}</span>}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
            </div>

            <div className="card">
              <div className="card-title">Top Movers — Down</div>
              {report.topMoversDown.length === 0
                ? <p style={{ color: 'var(--muted)', fontSize: 13 }}>None</p>
                : (
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Service</th><th>MoM Delta</th><th>Classification</th></tr></thead>
                      <tbody>
                        {report.topMoversDown.map(m => {
                          const cls = report.serviceSummary.find(s => s.serviceType === m.serviceType)?.classification ?? ''
                          return (
                            <tr key={m.serviceType}>
                              <td>{m.serviceType}</td>
                              <td><span className="down">▼ ${Math.abs(m.momDelta).toLocaleString()}</span></td>
                              <td>
                                {cls === 'Persistent Issue' && <span className="badge badge-red">{cls}</span>}
                                {cls === 'New Insight' && <span className="badge badge-yellow">{cls}</span>}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
            </div>
          </div>

          <div className="card">
            <div className="card-title">Service Summary</div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Service</th><th>Savings Total</th><th>MoM Delta</th>
                    <th>Direction</th><th>Classification</th>
                  </tr>
                </thead>
                <tbody>
                  {report.serviceSummary.map(row => (
                    <tr key={row.serviceType}>
                      <td style={{ fontWeight: 600 }}>{row.serviceType}</td>
                      <td>${row.savingsTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                      <td><span className={dirClass(row.direction)}>{dirArrow(row.direction)} ${Math.abs(row.momDelta).toLocaleString()}</span></td>
                      <td>
                        <span className={row.direction === 'Up' ? 'badge badge-red' : row.direction === 'Down' ? 'badge badge-green' : 'badge badge-gray'}>
                          {row.direction}
                        </span>
                      </td>
                      <td>
                        {row.classification === 'Persistent Issue' && <span className="badge badge-red">{row.classification}</span>}
                        {row.classification === 'New Insight' && <span className="badge badge-yellow">{row.classification}</span>}
                        {!row.classification && <span style={{ color: 'var(--muted)' }}>—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </main>
  )
}
