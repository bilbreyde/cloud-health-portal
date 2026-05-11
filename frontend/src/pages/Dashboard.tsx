import { useState } from 'react'
import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import { fetchTrends } from '../api'
import CustomerSelector from '../components/CustomerSelector'
import type { Mover, ServiceRow, TrendsResponse } from '../types'

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const SERVICE_COLORS: Record<string, string> = {
  EC2: '#0078D4', RDS: '#2B88D8', S3: '#107C10', EBS: '#00B7C3',
  ElastiCache: '#FFB900', Redshift: '#7160E8', OpenSearch: '#E81123',
  DynamoDB: '#FF8C00', Consolidated: '#767676',
}

function getColor(svc: string) { return SERVICE_COLORS[svc] ?? '#767676' }

function fmt(n: number) {
  return `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function DeltaCell({ row }: { row: Pick<ServiceRow, 'momDelta' | 'direction'> }) {
  const cls = row.direction === 'Up' ? 'up' : row.direction === 'Down' ? 'down' : 'flat'
  const sign = row.direction === 'Up' ? '▲' : row.direction === 'Down' ? '▼' : '—'
  return <span className={cls}>{sign} {fmt(row.momDelta)}</span>
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
            <thead>
              <tr><th>Service</th><th>MoM Delta</th></tr>
            </thead>
            <tbody>
              {movers.map(m => (
                <tr key={m.serviceType}>
                  <td>{m.serviceType}</td>
                  <td>
                    <span className={up ? 'up' : 'down'}>
                      {up ? '▲' : '▼'} {fmt(m.momDelta)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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

  function load() {
    if (!customerId) return
    setLoading(true)
    setError('')
    fetchTrends(customerId, { startMonth, startYear, endMonth, endYear })
      .then(d => { setData(d); setLoading(false) })
      .catch(e => { setError(String(e)); setLoading(false) })
  }

  const allServices = data
    ? [...new Set(data.monthly_totals.flatMap(mt => Object.keys(mt.byService)))]
    : []

  const chartData = data?.monthly_totals.map(mt => ({
    name: `${MONTH_ABBR[mt.month - 1]} ${mt.year}`,
    Total: mt.total,
    ...mt.byService,
  })) ?? []

  return (
    <main className="page">
      <h1 className="page-title">Dashboard</h1>

      <div className="card">
        <div className="controls">
          <CustomerSelector value={customerId} onChange={setCustomerId} />
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

      {data && (
        <>
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

          <div className="grid-2">
            <MoversTable title="Top Movers — Spending Up" movers={data.top_movers_up} up={true} />
            <MoversTable title="Top Movers — Savings Down" movers={data.top_movers_down} up={false} />
          </div>

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
        </>
      )}
    </main>
  )
}
