import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import { fetchDashboardNarrative, fetchTrends, patchCommitment } from '../api'
import CustomerSelector from '../components/CustomerSelector'
import type { DashboardNarrativeResponse, DataSnapshot, Mover, ServiceRow, TrendsResponse } from '../types'

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const SERVICE_COLORS: Record<string, string> = {
  EC2: '#0078D4', RDS: '#2B88D8', S3: '#107C10', EBS: '#00B7C3',
  ElastiCache: '#FFB900', Redshift: '#7160E8', OpenSearch: '#E81123',
  DynamoDB: '#FF8C00', Consolidated: '#767676',
}

function getColor(svc: string) { return SERVICE_COLORS[svc] ?? '#767676' }

function fmtMoney(n: number) {
  return '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function timeAgo(isoStr: string): string {
  const mins = Math.floor((Date.now() - new Date(isoStr).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  return `${Math.floor(mins / 60)}h ago`
}

function MetricPill({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={{
      padding: '10px 16px', background: 'var(--bg)', borderRadius: 6,
      border: '1px solid var(--border)', minWidth: 140, textAlign: 'center',
    }}>
      <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 700, color: accent ?? 'var(--text)' }}>{value}</div>
    </div>
  )
}

function NarrSection({ label, text, accent }: { label: string; text: string; accent?: boolean }) {
  return (
    <div style={{
      padding: '12px 14px', background: 'var(--bg)', borderRadius: 6,
      border: `1px solid ${accent ? 'var(--blue)' : 'var(--border)'}`,
    }}>
      <div style={{
        fontSize: 11, fontWeight: 700, color: accent ? 'var(--blue)' : 'var(--muted)',
        textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6,
      }}>{label}</div>
      <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text)' }}>{text || '—'}</div>
    </div>
  )
}

function DeltaCell({ row }: { row: Pick<ServiceRow, 'momDelta' | 'direction'> }) {
  const cls = row.direction === 'Up' ? 'up' : row.direction === 'Down' ? 'down' : 'flat'
  const sign = row.direction === 'Up' ? '▲' : row.direction === 'Down' ? '▼' : '—'
  return <span className={cls}>{sign} {fmtMoney(row.momDelta)}</span>
}

function MoversTable({ title, movers, up }: { title: string; movers: Mover[]; up: boolean }) {
  return (
    <div className="card">
      <div className="card-title">{title}</div>
      {movers.length === 0 ? (
        <p style={{ color: 'var(--muted)', fontSize: 13 }}>No data</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Service</th><th>MoM Delta</th></tr></thead>
            <tbody>
              {movers.map(m => (
                <tr key={m.serviceType}>
                  <td>{m.serviceType}</td>
                  <td><span className={up ? 'up' : 'down'}>{up ? '▲' : '▼'} {fmtMoney(m.momDelta)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function ExceptionDeltaWidget({ snapshot }: { snapshot: DataSnapshot }) {
  const rows: { label: string; value: number; op?: string; accent?: string; link?: string }[] = [
    { label: 'CloudHealth Signal', value: snapshot.signal },
    { label: 'Exception Floor', value: snapshot.exceptionFloor, op: '−', accent: 'var(--red)', link: '/exceptions' },
    { label: 'Net Addressable', value: snapshot.netAddressable, op: '=', accent: 'var(--blue)' },
  ]
  if (snapshot.realizedSavings > 0) {
    rows.push({ label: 'Realized Savings', value: snapshot.realizedSavings, op: '−', accent: 'var(--green)' })
    rows.push({ label: 'Remaining Opportunity', value: snapshot.remaining, op: '=', accent: 'var(--blue-dark)' })
  }

  return (
    <div className="card">
      <div className="card-title">Exception &amp; Signal Delta</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {rows.map(({ label, value, op, accent, link }, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '8px 0',
            borderBottom: i < rows.length - 1 ? '1px solid var(--border)' : undefined,
          }}>
            {op && (
              <span style={{ width: 20, textAlign: 'center', color: accent ?? 'var(--muted)', fontWeight: 700, fontSize: 16 }}>{op}</span>
            )}
            {!op && <span style={{ width: 20 }} />}
            <span style={{ flex: 1, fontSize: 13, color: 'var(--muted)' }}>
              {link ? (
                <Link to={link} style={{ color: 'var(--red)', textDecoration: 'none', borderBottom: '1px dashed var(--red)' }}>
                  {label}
                </Link>
              ) : label}
            </span>
            <span style={{ fontWeight: 700, fontSize: 14, color: accent ?? 'var(--text)' }}>
              {fmtMoney(value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function now() { const d = new Date(); return { month: d.getMonth() + 1, year: d.getFullYear() } }

export default function Dashboard() {
  const today = now()
  const [customerId, setCustomerId] = useState('')
  const [startMonth, setStartMonth] = useState(1)
  const [startYear, setStartYear] = useState(2026)
  const [endMonth, setEndMonth] = useState(today.month)
  const [endYear, setEndYear] = useState(today.year)
  const [data, setData] = useState<TrendsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [narr, setNarr] = useState<DashboardNarrativeResponse | null>(null)
  const [narrLoading, setNarrLoading] = useState(false)
  const [narrError, setNarrError] = useState('')
  const [joelExpanded, setJoelExpanded] = useState(false)

  useEffect(() => {
    if (!customerId) { setNarr(null); return }
    setNarrLoading(true)
    setNarrError('')
    fetchDashboardNarrative(customerId)
      .then(setNarr)
      .catch(e => setNarrError(String(e)))
      .finally(() => setNarrLoading(false))
  }, [customerId])

  function loadNarrative(force: boolean) {
    if (!customerId) return
    setNarrLoading(true)
    setNarrError('')
    fetchDashboardNarrative(customerId, force)
      .then(setNarr)
      .catch(e => setNarrError(String(e)))
      .finally(() => setNarrLoading(false))
  }

  function load() {
    if (!customerId) return
    setLoading(true)
    setError('')
    fetchTrends(customerId, { startMonth, startYear, endMonth, endYear })
      .then(d => { setData(d); setLoading(false) })
      .catch(e => { setError(String(e)); setLoading(false) })
  }

  async function toggleCommitment(idx: number, checked: boolean) {
    const key = String(idx)
    setNarr(prev => prev ? { ...prev, commitments: { ...prev.commitments, [key]: checked } } : prev)
    try {
      await patchCommitment(customerId, key, checked)
    } catch {
      setNarr(prev => prev ? { ...prev, commitments: { ...prev.commitments, [key]: !checked } } : prev)
    }
  }

  const allServices = data
    ? [...new Set(data.monthly_totals.flatMap(mt => Object.keys(mt.byService)))]
    : []

  const chartData = data?.monthly_totals.map(mt => ({
    name: `${MONTH_ABBR[mt.month - 1]} ${mt.year}`,
    Total: mt.total,
    ...mt.byService,
  })) ?? []

  const hasSteps = narr && narr.prevNextSteps.length > 0
  const hasJoel  = narr && narr.dataSnapshot.joelNotes

  return (
    <main className="page">
      <h1 className="page-title">Dashboard</h1>

      {/* ── AI INSIGHTS ─────────────────────────────────────────────────────── */}
      {customerId && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
              <span className="card-title" style={{ margin: 0 }}>AI Insights</span>
              {narr && !narrLoading && (
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                  {timeAgo(narr.generatedAt)}{narr.cached ? ' · cached' : ''}
                </span>
              )}
            </div>
            <button
              className="btn btn-ghost"
              onClick={() => loadNarrative(true)}
              disabled={narrLoading}
              style={{ fontSize: 13 }}
            >
              {narrLoading
                ? <><span className="spinner" style={{ borderTopColor: 'var(--blue)' }} /> Loading…</>
                : '↻ Refresh Insights'}
            </button>
          </div>

          {narrError && <div className="alert alert-error">{narrError}</div>}

          {narrLoading && !narr && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[60, 48, 48, 48].map((h, i) => (
                <div key={i} style={{ height: h, background: 'var(--border)', borderRadius: 4, opacity: 0.6 }} />
              ))}
            </div>
          )}

          {narr && (
            <>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
                <MetricPill label="CloudHealth Signal" value={fmtMoney(narr.dataSnapshot.signal)} />
                <MetricPill label="Exception Floor" value={fmtMoney(narr.dataSnapshot.exceptionFloor)} accent="var(--red)" />
                <MetricPill label="Net Addressable" value={fmtMoney(narr.dataSnapshot.netAddressable)} accent="var(--blue)" />
                {narr.dataSnapshot.realizedSavings > 0 && (
                  <MetricPill label="Realized Savings" value={fmtMoney(narr.dataSnapshot.realizedSavings)} accent="var(--green)" />
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <NarrSection label="Situation" text={narr.narrative.situation} />
                <NarrSection label="Trend" text={narr.narrative.trend} />
                <NarrSection label="Exception Context" text={narr.narrative.exceptions} />
                <NarrSection label="Recommendation" text={narr.narrative.recommendation} accent />
              </div>
            </>
          )}
        </div>
      )}

      {/* ── CONTROLS ────────────────────────────────────────────────────────── */}
      <div className="card">
        <div className="controls">
          <CustomerSelector value={customerId} onChange={id => { setCustomerId(id); setData(null) }} />
          <div className="field">
            <label>Start</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <select value={startMonth} onChange={e => setStartMonth(+e.target.value)} style={{ minWidth: 90 }}>
                {MONTH_ABBR.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </select>
              <select value={startYear} onChange={e => setStartYear(+e.target.value)} style={{ minWidth: 90 }}>
                {[2026, 2027, 2028].map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
          </div>
          <div className="field">
            <label>End</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <select value={endMonth} onChange={e => setEndMonth(+e.target.value)} style={{ minWidth: 90 }}>
                {MONTH_ABBR.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </select>
              <select value={endYear} onChange={e => setEndYear(+e.target.value)} style={{ minWidth: 90 }}>
                {[2026, 2027, 2028].map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
          </div>
          <button className="btn btn-primary" onClick={load} disabled={!customerId || loading}>
            {loading ? <><span className="spinner" /> Loading…</> : 'Load Data'}
          </button>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
      </div>

      {/* ── CHART ───────────────────────────────────────────────────────────── */}
      {data && (
        <div className="card">
          <div className="card-title">Monthly Savings Signal</div>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData} margin={{ top: 4, right: 16, bottom: 0, left: 16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis tickFormatter={v => `$${(v as number / 1000).toFixed(0)}k`} tick={{ fontSize: 12 }} />
              <Tooltip formatter={(v) => [`$${Number(v ?? 0).toLocaleString()}`, '']} />
              <Legend />
              <Line type="monotone" dataKey="Total" stroke="#1B2A3B" strokeWidth={2} dot={false} />
              {allServices.map(svc => (
                <Line key={svc} type="monotone" dataKey={svc}
                  stroke={getColor(svc)} strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── EXCEPTION DELTA WIDGET ──────────────────────────────────────────── */}
      {narr && <ExceptionDeltaWidget snapshot={narr.dataSnapshot} />}

      {/* ── TOP MOVERS ──────────────────────────────────────────────────────── */}
      {data && (
        <div className="grid-2">
          <MoversTable title="Top Movers — Spending Up" movers={data.top_movers_up} up={true} />
          <MoversTable title="Top Movers — Savings Down" movers={data.top_movers_down} up={false} />
        </div>
      )}

      {/* ── PREVIOUS COMMITMENTS ────────────────────────────────────────────── */}
      {narr && (
        <div className="card">
          <div className="card-title">
            Previous Commitments
            {narr.dataSnapshot.prevReportLabel && (
              <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 13, marginLeft: 8 }}>
                — {narr.dataSnapshot.prevReportLabel}
              </span>
            )}
          </div>

          {!hasSteps && (
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>
              No previous commitments found.{' '}
              <Link to="/history" style={{ color: 'var(--blue)' }}>
                Import a past report
              </Link>{' '}
              from the History page to track next steps here.
            </p>
          )}

          {hasSteps && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: hasJoel ? 16 : 0 }}>
              {narr.prevNextSteps.map((step, i) => (
                <label key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={narr.commitments[String(i)] ?? false}
                    onChange={e => toggleCommitment(i, e.target.checked)}
                    style={{ marginTop: 2, flexShrink: 0 }}
                  />
                  <span style={{
                    fontSize: 13, lineHeight: 1.5,
                    textDecoration: narr.commitments[String(i)] ? 'line-through' : undefined,
                    color: narr.commitments[String(i)] ? 'var(--muted)' : 'var(--text)',
                  }}>{step}</span>
                </label>
              ))}
            </div>
          )}

          {hasJoel && (
            <div>
              <button
                className="btn btn-ghost"
                onClick={() => setJoelExpanded(v => !v)}
                style={{ fontSize: 12, padding: '4px 10px' }}
              >
                {joelExpanded ? '▲ Hide' : '▼ Show'} Joel's Notes
              </button>
              {joelExpanded && (
                <div style={{
                  marginTop: 10, padding: '12px 14px', background: 'var(--bg)',
                  borderRadius: 6, fontSize: 13, lineHeight: 1.6, color: 'var(--text)',
                  border: '1px solid var(--border)', whiteSpace: 'pre-wrap',
                }}>
                  {narr.dataSnapshot.joelNotes}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── SERVICE BREAKDOWN ───────────────────────────────────────────────── */}
      {data && (
        <div className="card">
          <div className="card-title">Service Breakdown</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Service</th>
                  {MONTH_ABBR.map(m => <th key={m}>{m} Avg</th>)}
                  <th>MoM Delta</th>
                  <th>Direction</th>
                </tr>
              </thead>
              <tbody>
                {data.service_summary.map(row => (
                  <tr key={row.serviceType}>
                    <td style={{ fontWeight: 600 }}>{row.serviceType}</td>
                    {(['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'] as const).map(m => {
                      const v = row[m]
                      return <td key={m} style={{ color: v == null ? 'var(--muted)' : undefined }}>
                        {v == null ? '—' : `$${v.toLocaleString()}`}
                      </td>
                    })}
                    <td><DeltaCell row={row} /></td>
                    <td>
                      <span className={row.direction === 'Up' ? 'badge badge-red' : row.direction === 'Down' ? 'badge badge-green' : 'badge badge-gray'}>
                        {row.direction}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </main>
  )
}
