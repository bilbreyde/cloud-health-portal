import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Bar, BarChart, CartesianGrid, Cell, LabelList, Legend, Line, LineChart,
  ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { fetchDashboardNarrative, fetchTrends, patchCommitment } from '../api'
import { useCustomer } from '../context/CustomerContext'
import type { DashboardNarrativeResponse, DataSnapshot, ServiceRow, TrendsResponse } from '../types'

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const SERVICE_COLORS: Record<string, string> = {
  EC2:         '#0078D4',
  RDS:         '#2B88D8',
  S3:          '#107C10',
  EBS:         '#00B7C3',
  ElastiCache: '#FFB900',
  Redshift:    '#7160E8',
  OpenSearch:  '#E81123',
  DynamoDB:    '#FF8C00',
  Consolidated:'#767676',
}
function svcColor(svc: string) { return SERVICE_COLORS[svc] ?? '#767676' }

function fmtMoney(n: number) {
  return '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function fmtK(n: number) {
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 1000)      return `$${(abs / 1000).toFixed(0)}k`
  return fmtMoney(n)
}
function timeAgo(isoStr: string): string {
  const mins = Math.floor((Date.now() - new Date(isoStr).getTime()) / 60000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins} min ago`
  return `${Math.floor(mins / 60)}h ago`
}
function now() { const d = new Date(); return { month: d.getMonth() + 1, year: d.getFullYear() } }

// ── Small shared components ─────────────────────────────────────────────────

function Skeleton({ height = 40 }: { height?: number }) {
  return <div style={{ height, background: 'var(--border)', borderRadius: 4, opacity: 0.6, marginBottom: 8 }} />
}

function MetricPill({
  label, value, accent, sub,
}: { label: string; value: string; accent?: string; sub?: string }) {
  return (
    <div style={{
      flex: '1 1 140px', padding: '12px 14px', background: 'var(--surface)',
      border: '1px solid var(--border)', borderRadius: 8,
      borderTop: `3px solid ${accent ?? 'var(--border)'}`,
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 5 }}>
        {label}
      </div>
      <div style={{ fontSize: 17, fontWeight: 700, color: accent ?? 'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3 }}>{sub}</div>}
    </div>
  )
}

function NarrSection({ label, text, accent }: { label: string; text: string; accent?: boolean }) {
  return (
    <div style={{
      padding: '10px 12px', background: 'var(--bg)', borderRadius: 6, marginBottom: 10,
      borderLeft: `3px solid ${accent ? 'var(--blue)' : 'var(--border)'}`,
    }}>
      <div style={{
        fontSize: 10, fontWeight: 700, letterSpacing: '.5px',
        textTransform: 'uppercase', color: accent ? 'var(--blue)' : 'var(--muted)',
        marginBottom: 5,
      }}>{label}</div>
      <div style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--text)' }}>{text || '—'}</div>
    </div>
  )
}

function DeltaCell({ row }: { row: Pick<ServiceRow, 'momDelta' | 'direction'> }) {
  const cls  = row.direction === 'Up' ? 'up' : row.direction === 'Down' ? 'down' : 'flat'
  const sign = row.direction === 'Up' ? '▲' : row.direction === 'Down' ? '▼' : '—'
  return <span className={cls}>{sign} {fmtMoney(row.momDelta)}</span>
}

// BarChart custom label — shows value above (positive) or below (negative) bar
interface BarLabelProps { x?: number; y?: number; width?: number; height?: number; value?: number }
function BarValueLabel({ x = 0, y = 0, width = 0, height = 0, value = 0 }: BarLabelProps) {
  if (Math.abs(value) < 500) return null
  const isNeg = value < 0
  const label = `${value > 0 ? '+' : '−'}${fmtK(Math.abs(value))}`
  const barH  = Math.abs(height)
  return (
    <text
      x={x + width / 2}
      y={isNeg ? y + barH + 13 : y - 5}
      textAnchor="middle"
      fontSize={9}
      fontWeight={600}
      fill={isNeg ? '#107C10' : '#C50F1F'}
    >
      {label}
    </text>
  )
}

function ExceptionDeltaWidget({ snapshot }: { snapshot: DataSnapshot }) {
  const rows: { label: string; value: number; op?: string; color?: string; link?: string }[] = [
    { label: 'CloudHealth Signal',  value: snapshot.signal },
    { label: 'Exception Floor',     value: snapshot.exceptionFloor, op: '−', color: '#FF8C00', link: '/exceptions' },
    { label: 'Net Addressable',     value: snapshot.netAddressable, op: '=', color: 'var(--blue)' },
  ]
  if (snapshot.realizedSavings > 0) {
    rows.push({ label: 'Realized Savings',      value: snapshot.realizedSavings, op: '−', color: 'var(--green)' })
    rows.push({ label: 'Remaining Opportunity', value: snapshot.remaining,       op: '=', color: '#7160E8' })
  }
  return (
    <div className="card">
      <div className="card-title">Exception &amp; Signal Delta</div>
      {rows.map(({ label, value, op, color, link }, i) => (
        <div key={i} style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '7px 0',
          borderBottom: i < rows.length - 1 ? '1px solid var(--border)' : undefined,
        }}>
          <span style={{ width: 20, textAlign: 'center', fontWeight: 700, fontSize: 15, color: color ?? 'var(--muted)' }}>
            {op ?? ''}
          </span>
          <span style={{ flex: 1, fontSize: 13, color: 'var(--muted)' }}>
            {link
              ? <Link to={link} style={{ color, borderBottom: `1px dashed ${color}` }}>{label}</Link>
              : label}
          </span>
          <span style={{ fontWeight: 700, fontSize: 14, color: color ?? 'var(--text)' }}>{fmtMoney(value)}</span>
        </div>
      ))}
    </div>
  )
}

// ── Main component ──────────────────────────────────────────────────────────

export default function Dashboard() {
  const today = now()
  const { selectedCustomer } = useCustomer()
  const customerId = selectedCustomer?.id ?? ''
  const [startMonth, setStartMonth] = useState(1)
  const [startYear,  setStartYear]  = useState(2026)
  const [endMonth,   setEndMonth]   = useState(today.month)
  const [endYear,    setEndYear]    = useState(today.year)
  const [data,    setData]    = useState<TrendsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')

  const [narr,        setNarr]        = useState<DashboardNarrativeResponse | null>(null)
  const [narrLoading, setNarrLoading] = useState(false)
  const [narrError,   setNarrError]   = useState('')
  const [joelExpanded, setJoelExpanded] = useState(false)

  useEffect(() => {
    setData(null)
    setError('')
  }, [customerId])

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

  // ── Derived: line chart ───────────────────────────────────────────────────
  const allServices = data
    ? [...new Set(data.monthly_totals.flatMap(mt => Object.keys(mt.byService)))]
    : []

  const lineChartData = data?.monthly_totals.map(mt => ({
    name: `${MONTH_ABBR[mt.month - 1]} ${mt.year}`,
    Total: mt.total,
    ...mt.byService,
  })) ?? []

  // ── Derived: MoM bar chart ────────────────────────────────────────────────
  const barData = data?.service_summary
    .map(r => ({ service: r.serviceType, delta: r.momDelta, direction: r.direction }))
    .sort((a, b) => b.delta - a.delta) ?? []

  // ── Derived: snapshot trend ───────────────────────────────────────────────
  const snapshotData = (() => {
    if (!data) return []
    const byDate = new Map<string, number>()
    for (const s of data.snapshots_detail.filter(s => s.month === endMonth && s.year === endYear)) {
      byDate.set(s.snapshotDate, (byDate.get(s.snapshotDate) ?? 0) + s.savingsTotal)
    }
    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, total]) => ({ date: date.slice(5), total }))
  })()
  const showSnapshot = snapshotData.length > 1

  // ── Derived: MoM % pill ───────────────────────────────────────────────────
  const momPct = (() => {
    if (!data || data.monthly_totals.length < 2) return null
    const sorted = [...data.monthly_totals].sort((a, b) =>
      a.year !== b.year ? a.year - b.year : a.month - b.month,
    )
    const last = sorted[sorted.length - 1]
    const prev = sorted[sorted.length - 2]
    if (!prev || prev.total === 0) return null
    return ((last.total - prev.total) / prev.total) * 100
  })()

  const hasSteps = narr && narr.prevNextSteps.length > 0
  const hasJoel  = narr && narr.dataSnapshot.joelNotes

  return (
    <main className="page">
      <h1 className="page-title">Dashboard</h1>

      {/* ── CONTROLS ─────────────────────────────────────────────────────── */}
      <div className="card">
        <div className="controls">
          <div className="field">
            <label>Start</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <select value={startMonth} onChange={e => setStartMonth(+e.target.value)} style={{ minWidth: 80 }}>
                {MONTH_ABBR.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </select>
              <select value={startYear} onChange={e => setStartYear(+e.target.value)} style={{ minWidth: 80 }}>
                {[2026, 2027, 2028].map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
          </div>
          <div className="field">
            <label>End</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <select value={endMonth} onChange={e => setEndMonth(+e.target.value)} style={{ minWidth: 80 }}>
                {MONTH_ABBR.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </select>
              <select value={endYear} onChange={e => setEndYear(+e.target.value)} style={{ minWidth: 80 }}>
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

      {/* ── EMPTY STATE ──────────────────────────────────────────────────── */}
      {!customerId && (
        <div className="card" style={{ textAlign: 'center', padding: '48px 20px' }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>No customer selected</div>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>
            Choose a customer from the selector in the top navigation bar.
          </div>
        </div>
      )}

      {/* ── METRIC PILLS ─────────────────────────────────────────────────── */}
      {customerId && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
          <MetricPill
            label="CloudHealth Signal"
            value={narr ? fmtMoney(narr.dataSnapshot.signal) : '—'}
            accent="#0078D4"
            sub={narr
              ? `${MONTH_ABBR[narr.dataSnapshot.reportingMonth - 1]} ${narr.dataSnapshot.reportingYear}`
              : undefined}
          />
          <MetricPill
            label="Exception Floor"
            value={narr ? fmtMoney(narr.dataSnapshot.exceptionFloor) : '—'}
            accent="#FF8C00"
          />
          <MetricPill
            label="Net Addressable"
            value={narr ? fmtMoney(narr.dataSnapshot.netAddressable) : '—'}
            accent="#7160E8"
          />
          <MetricPill
            label="Realized Savings"
            value={narr && narr.dataSnapshot.realizedSavings > 0
              ? fmtMoney(narr.dataSnapshot.realizedSavings) : '—'}
            accent="#107C10"
          />
          <MetricPill
            label="MoM Change"
            value={momPct !== null ? `${momPct > 0 ? '+' : ''}${momPct.toFixed(1)}%` : '—'}
            accent={momPct !== null ? (momPct > 0 ? '#C50F1F' : '#107C10') : undefined}
            sub={momPct !== null
              ? (momPct > 0 ? 'Signal increasing' : 'Signal decreasing')
              : 'Load data to see'}
          />
        </div>
      )}

      {/* ── ROW 2: Line chart (65%) + AI Insights (35%) ──────────────────── */}
      {customerId && (
        <div style={{ display: 'flex', gap: 20, marginBottom: 20, flexWrap: 'wrap', alignItems: 'stretch' }}>

          {/* LEFT — Monthly Savings Signal */}
          <div className="card" style={{ flex: '13 1 520px', minWidth: 0, marginBottom: 0 }}>
            <div className="card-title">Monthly Savings Signal</div>
            {loading && (
              <>
                <Skeleton height={28} />
                <Skeleton height={340} />
              </>
            )}
            {!loading && !data && (
              <div style={{
                height: 340, display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', gap: 8,
                color: 'var(--muted)', fontSize: 13,
              }}>
                <span style={{ fontSize: 32, opacity: .3 }}>↑</span>
                Select a date range and click <strong>Load Data</strong> to see charts.
              </div>
            )}
            {data && (
              <ResponsiveContainer width="100%" height={360}>
                <LineChart data={lineChartData} margin={{ top: 4, right: 16, bottom: 0, left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis
                    tickFormatter={v => `$${((v as number) / 1000).toFixed(0)}k`}
                    tick={{ fontSize: 11 }}
                    width={52}
                  />
                  <Tooltip
                    formatter={(v, name) => [`$${Number(v ?? 0).toLocaleString()}`, String(name)]}
                    contentStyle={{ fontSize: 12 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
                  <Line
                    type="monotone" dataKey="Total"
                    stroke="#1B2A3B" strokeWidth={2.5} dot={false}
                  />
                  {allServices.map(svc => (
                    <Line
                      key={svc} type="monotone" dataKey={svc}
                      stroke={svcColor(svc)} strokeWidth={1.5} dot={false} strokeDasharray="4 2"
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* RIGHT — AI Insights */}
          <div className="card" style={{ flex: '7 1 280px', minWidth: 0, marginBottom: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="card-title" style={{ margin: 0 }}>AI Insights</span>
                <span className="badge badge-blue" style={{ fontSize: 9, padding: '1px 6px' }}>AI</span>
              </div>
              <button
                className="btn btn-ghost"
                onClick={() => loadNarrative(true)}
                disabled={narrLoading}
                style={{ fontSize: 12, padding: '3px 10px' }}
              >
                {narrLoading
                  ? <><span className="spinner" style={{ borderTopColor: 'var(--blue)', width: 10, height: 10 }} /> Loading…</>
                  : '↻ Refresh'}
              </button>
            </div>

            {narr && (
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 12 }}>
                {timeAgo(narr.generatedAt)}{narr.cached ? ' · cached' : ''}
              </div>
            )}

            {narrError && (
              <div className="alert alert-error" style={{ fontSize: 12, marginBottom: 10 }}>{narrError}</div>
            )}

            <div style={{ flex: 1, overflowY: 'auto' }}>
              {narrLoading && !narr && (
                <>
                  <Skeleton height={72} />
                  <Skeleton height={54} />
                  <Skeleton height={54} />
                  <Skeleton height={54} />
                </>
              )}
              {!narrLoading && !narr && !narrError && (
                <div style={{ color: 'var(--muted)', fontSize: 12, paddingTop: 12 }}>
                  Generating AI insights…
                </div>
              )}
              {narr && (
                <>
                  <NarrSection label="Situation"        text={narr.narrative.situation} />
                  <NarrSection label="Trend"             text={narr.narrative.trend} />
                  <NarrSection label="Exception Context" text={narr.narrative.exceptions} />
                  <NarrSection label="Recommendation"   text={narr.narrative.recommendation} accent />
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── ROW 3: MoM BarChart (50%) + Top Movers (50%) ─────────────────── */}
      {data && (
        <div style={{ display: 'flex', gap: 20, marginBottom: 20, flexWrap: 'wrap', alignItems: 'stretch' }}>

          {/* MoM Delta BarChart */}
          <div className="card" style={{ flex: '1 1 360px', minWidth: 0, marginBottom: 0 }}>
            <div className="card-title">MoM Delta by Service</div>
            {barData.length === 0 ? (
              <p style={{ color: 'var(--muted)', fontSize: 13 }}>No previous month data for comparison.</p>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={barData} margin={{ top: 28, right: 12, bottom: 52, left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="service"
                    tick={{ fontSize: 11 }}
                    interval={0}
                    angle={-35}
                    textAnchor="end"
                    height={60}
                  />
                  <YAxis
                    tickFormatter={v => `$${(Math.abs(v as number) / 1000).toFixed(0)}k`}
                    tick={{ fontSize: 11 }}
                    width={48}
                  />
                  <Tooltip
                    formatter={(v) => [
                      `${(v as number) < 0 ? '−' : '+'}${fmtMoney(Math.abs(v as number))}`,
                      'MoM Delta',
                    ]}
                    contentStyle={{ fontSize: 12 }}
                  />
                  <ReferenceLine y={0} stroke="var(--muted)" strokeWidth={1} />
                  <Bar dataKey="delta" radius={[3, 3, 0, 0]} maxBarSize={48}>
                    {barData.map((entry, i) => (
                      <Cell
                        key={i}
                        fill={
                          entry.direction === 'Down' ? '#107C10' :
                          entry.direction === 'Up'   ? '#C50F1F' : '#767676'
                        }
                      />
                    ))}
                    <LabelList content={BarValueLabel as unknown as () => null} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
              Green = cost decreasing (good) · Red = cost increasing
            </div>
          </div>

          {/* Top Movers — stacked */}
          <div style={{ flex: '1 1 280px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div className="card" style={{ marginBottom: 0, flex: 1 }}>
              <div className="card-title">Top Movers — Up</div>
              {data.top_movers_up.length === 0
                ? <p style={{ color: 'var(--muted)', fontSize: 13 }}>None</p>
                : (
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Service</th><th>MoM Delta</th></tr></thead>
                      <tbody>
                        {data.top_movers_up.map(m => (
                          <tr key={m.serviceType}>
                            <td>{m.serviceType}</td>
                            <td><span className="up">▲ {fmtMoney(m.momDelta)}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </div>
            <div className="card" style={{ marginBottom: 0, flex: 1 }}>
              <div className="card-title">Top Movers — Down</div>
              {data.top_movers_down.length === 0
                ? <p style={{ color: 'var(--muted)', fontSize: 13 }}>None</p>
                : (
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Service</th><th>MoM Delta</th></tr></thead>
                      <tbody>
                        {data.top_movers_down.map(m => (
                          <tr key={m.serviceType}>
                            <td>{m.serviceType}</td>
                            <td><span className="down">▼ {fmtMoney(Math.abs(m.momDelta))}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </div>
          </div>
        </div>
      )}

      {/* ── Intra-month Snapshot Trend (only if >1 snapshot date) ────────── */}
      {showSnapshot && (
        <div className="card">
          <div className="card-title">
            Intra-Month Snapshot Trend — {MONTH_ABBR[endMonth - 1]} {endYear}
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={snapshotData} margin={{ top: 4, right: 16, bottom: 0, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis
                tickFormatter={v => `$${((v as number) / 1000).toFixed(0)}k`}
                tick={{ fontSize: 11 }}
                width={52}
              />
              <Tooltip
                formatter={(v) => [`$${Number(v ?? 0).toLocaleString()}`, 'Total Signal']}
                contentStyle={{ fontSize: 12 }}
              />
              <Line type="monotone" dataKey="total" stroke="var(--blue)" strokeWidth={2} dot={{ r: 5, fill: 'var(--blue)' }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── ROW 4: Service Breakdown ──────────────────────────────────────── */}
      {data && (
        <div className="card">
          <div className="card-title">Service Breakdown</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Service</th>
                  {MONTH_ABBR.map(m => <th key={m}>{m}</th>)}
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
                      return (
                        <td key={m} style={{ color: v == null ? 'var(--muted)' : undefined }}>
                          {v == null ? '—' : `$${v.toLocaleString()}`}
                        </td>
                      )
                    })}
                    <td><DeltaCell row={row} /></td>
                    <td>
                      <span className={
                        row.direction === 'Up'   ? 'badge badge-red' :
                        row.direction === 'Down' ? 'badge badge-green' : 'badge badge-gray'
                      }>
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

      {/* ── ROW 5: Exception Delta ────────────────────────────────────────── */}
      {narr && <ExceptionDeltaWidget snapshot={narr.dataSnapshot} />}

      {/* ── ROW 6: Previous Commitments ───────────────────────────────────── */}
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
              <Link to="/history">Import a past report</Link>{' '}
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
                  }}>
                    {step}
                  </span>
                </label>
              ))}
            </div>
          )}

          {hasJoel && (
            <>
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
                  borderRadius: 6, fontSize: 13, lineHeight: 1.6,
                  border: '1px solid var(--border)', whiteSpace: 'pre-wrap',
                }}>
                  {narr.dataSnapshot.joelNotes}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </main>
  )
}
