import { useState } from 'react'
import { buildReport } from '../api'
import { useCustomer } from '../context/CustomerContext'
import type { NarrativeDraft, ReportResponse } from '../types'

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
  const [error, setError]             = useState('')

  async function generate() {
    if (!customerId) return
    setGenerating(true)
    setError('')
    try {
      const res = await buildReport({ customerId, month, year, joelNotes: joelNotes || undefined })
      setReport(res)
      setDraft({ ...res.narrativeDraft })
    } catch (e) {
      setError(String(e))
    } finally {
      setGenerating(false)
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
            <div style={{ marginTop: 8, display: 'flex', gap: 10 }}>
              <button className="btn btn-ghost" disabled title="Coming soon">Export .docx</button>
            </div>
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
