import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { fetchInventorySnapshots, fetchReconciliation, importInventory } from '../api'
import { useCustomer } from '../context/CustomerContext'
import type {
  InventorySnapshot, ReconciliationReport, RightsizedInstance, TerminatedInstance, UnchangedInstance,
} from '../types'

function fmtMoney(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

const LIFECYCLE_BADGE: Record<string, string> = {
  PROD: 'badge-red',
  Production: 'badge-red',
  DEV: 'badge-blue',
  Development: 'badge-blue',
  UAT: 'badge-yellow',
  QA: 'badge-green',
}

function lifecycleBadge(lc: string): string {
  return LIFECYCLE_BADGE[lc] ?? LIFECYCLE_BADGE[lc?.toUpperCase()] ?? 'badge-gray'
}

function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]): void {
  const escape = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const lines = [headers.map(escape).join(','), ...rows.map(r => r.map(escape).join(','))]
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function uniqueSorted(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))].sort()
}

type TabKey = 'terminated' | 'rightsized' | 'unchanged'

function ProgressBar({ summary }: { summary: ReconciliationReport['summary'] }) {
  const total = summary.total || 1
  const termPct = (summary.terminated / total) * 100
  const rsPct = (summary.rightsized / total) * 100
  const ucPct = 100 - termPct - rsPct
  const addressed = summary.terminated + summary.rightsized

  return (
    <div className="card">
      <div className="card-title">Overall Progress</div>
      <div style={{
        display: 'flex', height: 22, borderRadius: 100, overflow: 'hidden',
        border: '1px solid var(--border)', marginBottom: 10,
      }}>
        <div style={{ width: `${termPct}%`, background: 'var(--red)' }} title={`Terminated: ${summary.terminated}`} />
        <div style={{ width: `${rsPct}%`, background: 'var(--blue)' }} title={`Rightsized: ${summary.rightsized}`} />
        <div style={{ width: `${ucPct}%`, background: 'var(--border)' }} title={`Unchanged: ${summary.activeUnchanged}`} />
      </div>
      <div style={{ fontSize: 13, color: 'var(--text)', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>
          {total > 0 ? ((addressed / total) * 100).toFixed(1) : '0.0'}% of exceptions addressed
          {' '}({addressed.toLocaleString()} of {summary.total.toLocaleString()})
        </span>
        <span><span style={{ color: 'var(--red)' }}>■</span> Terminated</span>
        <span><span style={{ color: 'var(--blue)' }}>■</span> Rightsized</span>
        <span><span style={{ color: 'var(--muted)' }}>■</span> Unchanged</span>
      </div>
    </div>
  )
}

export default function ExceptionTracker() {
  const { selectedCustomer } = useCustomer()
  const customerId = selectedCustomer?.id ?? ''

  const [snapshots, setSnapshots] = useState<InventorySnapshot[]>([])
  const [snapshotDateInput, setSnapshotDateInput] = useState(todayIso())
  const [selectedSnapshot, setSelectedSnapshot] = useState('')
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [report, setReport] = useState<ReconciliationReport | null>(null)
  const [loadingReport, setLoadingReport] = useState(false)
  const [reportError, setReportError] = useState('')

  const [trendReports, setTrendReports] = useState<Record<string, ReconciliationReport>>({})
  const [trendLoading, setTrendLoading] = useState(false)

  const [activeTab, setActiveTab] = useState<TabKey>('terminated')
  const [termFilterAccount, setTermFilterAccount] = useState('')
  const [termFilterLifecycle, setTermFilterLifecycle] = useState('')
  const [rsDownsizeOnly, setRsDownsizeOnly] = useState(false)
  const [ucFilterLifecycle, setUcFilterLifecycle] = useState('DEV')
  const [ucFilterAccount, setUcFilterAccount] = useState('')
  const [ucFilterProduct, setUcFilterProduct] = useState('')

  const loadSnapshots = useCallback((cid: string) => {
    if (!cid) { setSnapshots([]); setSelectedSnapshot(''); return }
    fetchInventorySnapshots(cid)
      .then(list => {
        setSnapshots(list)
        setSelectedSnapshot(prev => (prev && list.some(s => s.snapshotDate === prev)) ? prev : (list[0]?.snapshotDate ?? ''))
      })
      .catch(() => setSnapshots([]))
  }, [])

  useEffect(() => {
    setUcFilterLifecycle('DEV')
    setTermFilterAccount('')
    setTermFilterLifecycle('')
    setUcFilterAccount('')
    setUcFilterProduct('')
    loadSnapshots(customerId)
  }, [customerId, loadSnapshots])

  async function handleFileSelected(file: File) {
    if (!customerId) return
    setImporting(true)
    setImportMsg('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('snapshotDate', snapshotDateInput)
      const result = await importInventory(customerId, fd)
      setImportMsg(`Imported ${result.instanceCount.toLocaleString()} instances for ${result.snapshotDate}`)
      loadSnapshots(customerId)
      setSelectedSnapshot(result.snapshotDate)
    } catch (e) {
      setImportMsg(`Error: ${String(e)}`)
    } finally {
      setImporting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const runReconciliation = useCallback(() => {
    if (!customerId || !selectedSnapshot) { setReport(null); return }
    setLoadingReport(true)
    setReportError('')
    fetchReconciliation(customerId, selectedSnapshot)
      .then(setReport)
      .catch(e => { setReportError(String(e)); setReport(null) })
      .finally(() => setLoadingReport(false))
  }, [customerId, selectedSnapshot])

  useEffect(() => { runReconciliation() }, [runReconciliation])

  useEffect(() => {
    if (!customerId || snapshots.length < 2) { setTrendReports({}); return }
    setTrendLoading(true)
    Promise.all(
      snapshots.map(s => fetchReconciliation(customerId, s.snapshotDate).then(r => [s.snapshotDate, r] as const)),
    )
      .then(entries => setTrendReports(Object.fromEntries(entries)))
      .catch(() => setTrendReports({}))
      .finally(() => setTrendLoading(false))
  }, [customerId, snapshots])

  const terminated = report?.terminated ?? []
  const rightsized = report?.rightsized ?? []
  const unchanged = report?.activeUnchanged ?? []

  const termAccounts = useMemo(() => uniqueSorted(terminated.map(r => r.accountName)), [terminated])
  const termLifecycles = useMemo(() => uniqueSorted(terminated.map(r => r.lifecycle)), [terminated])
  const filteredTerminated = useMemo(() => terminated.filter(r =>
    (!termFilterAccount || r.accountName === termFilterAccount) &&
    (!termFilterLifecycle || r.lifecycle === termFilterLifecycle),
  ), [terminated, termFilterAccount, termFilterLifecycle])

  const filteredRightsized = useMemo(() => rightsized.filter(r =>
    !rsDownsizeOnly || r.direction === 'downsize',
  ), [rightsized, rsDownsizeOnly])

  const ucLifecycles = useMemo(() => uniqueSorted(unchanged.map(r => r.lifecycle)), [unchanged])
  const ucAccounts = useMemo(() => uniqueSorted(unchanged.map(r => r.accountName)), [unchanged])
  const ucProducts = useMemo(() => uniqueSorted(unchanged.map(r => r.product)), [unchanged])
  const filteredUnchanged = useMemo(() => unchanged.filter(r =>
    (!ucFilterLifecycle || r.lifecycle === ucFilterLifecycle) &&
    (!ucFilterAccount || r.accountName === ucFilterAccount) &&
    (!ucFilterProduct || r.product === ucFilterProduct),
  ), [unchanged, ucFilterLifecycle, ucFilterAccount, ucFilterProduct])

  function exportTerminated() {
    downloadCsv(
      `terminated_${report?.snapshotDate ?? 'export'}.csv`,
      ['Instance Name', 'Account', 'Lifecycle', 'Original Type', 'Monthly Cost', 'App Owner', 'Notes'],
      filteredTerminated.map((r: TerminatedInstance) => [
        r.instanceName || r.instanceId, r.accountName, r.lifecycle, r.originalType,
        r.originalMonthlyCost, r.appOwner, r.notes,
      ]),
    )
  }

  function exportRightsized() {
    downloadCsv(
      `rightsized_${report?.snapshotDate ?? 'export'}.csv`,
      ['Instance Name', 'Account', 'Lifecycle', 'Original Type', 'Current Type', 'Direction', 'Est. Monthly Savings'],
      filteredRightsized.map((r: RightsizedInstance) => [
        r.instanceName || r.instanceId, r.accountName, r.lifecycle, r.originalType, r.currentType,
        r.direction === 'downsize' ? 'Downsize' : 'Upsize',
        r.estimatedSavings ?? 'N/A',
      ]),
    )
  }

  function exportUnchanged() {
    downloadCsv(
      `unchanged_${report?.snapshotDate ?? 'export'}.csv`,
      ['Instance Name', 'Account', 'Lifecycle', 'Instance Type', 'Monthly Cost', 'App Owner', 'Product/Category'],
      filteredUnchanged.map((r: UnchangedInstance) => [
        r.instanceName || r.instanceId, r.accountName, r.lifecycle, r.apiName, r.monthlyCost, r.appOwner, r.product,
      ]),
    )
  }

  const trendData = useMemo(() => {
    return snapshots
      .slice()
      .sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate))
      .map(s => {
        const rep = trendReports[s.snapshotDate]
        return {
          date: s.snapshotDate,
          terminated: rep?.summary.terminated ?? 0,
          rightsized: rep?.summary.rightsized ?? 0,
          savings: rep?.summary.totalRealizedSavings ?? 0,
        }
      })
  }, [snapshots, trendReports])

  const firstTrend = trendData[0]
  const lastTrend = trendData[trendData.length - 1]

  return (
    <main className="page">
      <h1 className="page-title">Exception Progress Tracker</h1>

      {/* Section 1 — Import & snapshot selector */}
      <div className="card">
        <div className="card-title">Import Current Inventory</div>
        <div className="controls">
          {customerId && (
            <>
              <div className="field">
                <label>Snapshot Date</label>
                <input
                  type="date"
                  value={snapshotDateInput}
                  onChange={e => setSnapshotDateInput(e.target.value)}
                />
              </div>
              <input
                type="file"
                accept=".csv"
                ref={fileInputRef}
                style={{ display: 'none' }}
                onChange={e => { if (e.target.files?.[0]) handleFileSelected(e.target.files[0]) }}
              />
              <button
                className="btn btn-secondary"
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
              >
                {importing ? 'Importing…' : 'Import Current Inventory'}
              </button>
              <div className="field">
                <label>Analyze Snapshot</label>
                <select value={selectedSnapshot} onChange={e => setSelectedSnapshot(e.target.value)} style={{ minWidth: 200 }}>
                  {snapshots.length === 0 && <option value="">No snapshots imported</option>}
                  {snapshots.map(s => (
                    <option key={s.snapshotDate} value={s.snapshotDate}>
                      {s.snapshotDate} — {s.instanceCount.toLocaleString()} instances
                    </option>
                  ))}
                </select>
              </div>
              <button
                className="btn btn-primary"
                onClick={runReconciliation}
                disabled={!selectedSnapshot || loadingReport}
              >
                {loadingReport ? 'Running…' : 'Run Reconciliation'}
              </button>
            </>
          )}
        </div>
        {importMsg && (
          <div className={`alert ${importMsg.startsWith('Error') ? 'alert-error' : 'alert-success'}`}>
            {importMsg}
          </div>
        )}
        {!customerId && (
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>Select a customer to import inventory.</p>
        )}
      </div>

      {reportError && <div className="card" style={{ color: 'var(--red)' }}>{reportError}</div>}

      {!report && !loadingReport && !reportError && customerId && (
        <div className="card" style={{ textAlign: 'center', color: 'var(--muted)', padding: 32 }}>
          Import an inventory snapshot above, then run reconciliation to see decommission and rightsizing progress.
        </div>
      )}

      {report && (
        <>
          {/* Section 2 — Summary cards */}
          <div className="grid-2" style={{ gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
            <div className="card" style={{ margin: 0, textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6 }}>
                🔴 Terminated
              </div>
              <div style={{ fontSize: 32, fontWeight: 700, color: 'var(--green)' }}>
                {report.summary.terminated.toLocaleString()}
                {report.summary.duplicatesRemoved > 0 && (
                  <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--muted)' }}> (after deduplication)</span>
                )}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                {fmtMoney(report.summary.terminatedMonthlySavings)}/month savings realized
              </div>
              {report.summary.duplicatesRemoved > 0 && (
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                  Duplicates removed: {report.summary.duplicatesRemoved}
                </div>
              )}
            </div>
            <div className="card" style={{ margin: 0, textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6 }}>
                🟡 Rightsized
              </div>
              <div style={{ fontSize: 32, fontWeight: 700, color: 'var(--blue)' }}>{report.summary.rightsized.toLocaleString()}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                {fmtMoney(report.summary.rightsizedMonthlySavings)}/month estimated savings
              </div>
            </div>
            <div className="card" style={{ margin: 0, textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6 }}>
                ⚪ Unchanged
              </div>
              <div style={{ fontSize: 32, fontWeight: 700, color: 'var(--muted)' }}>{report.summary.activeUnchanged.toLocaleString()}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                {fmtMoney(report.summary.activeUnchangedMonthlyCost)}/month still in exceptions
              </div>
            </div>
            <div className="card" style={{ margin: 0, textAlign: 'center', borderColor: 'var(--green)' }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6 }}>
                🟢 Total Realized Savings
              </div>
              <div style={{ fontSize: 38, fontWeight: 700, color: 'var(--green)' }}>
                {fmtMoney(report.summary.totalRealizedSavings)}/mo
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                From terminated + rightsized exceptions
              </div>
            </div>
          </div>

          <div style={{ height: 20 }} />

          {/* Section 3 — Progress bar */}
          <ProgressBar summary={report.summary} />

          {/* Section 4 — Tabs */}
          <div className="card">
            <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 16 }}>
              {([
                ['terminated', `Terminated (${report.summary.terminated})`],
                ['rightsized', `Rightsized (${report.summary.rightsized})`],
                ['unchanged', `Unchanged (${report.summary.activeUnchanged})`],
              ] as [TabKey, string][]).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setActiveTab(key)}
                  className="btn"
                  style={{
                    background: activeTab === key ? 'var(--surface)' : 'transparent',
                    color: activeTab === key ? 'var(--blue)' : 'var(--muted)',
                    borderRadius: '6px 6px 0 0',
                    borderBottom: activeTab === key ? '2px solid var(--blue)' : '2px solid transparent',
                    fontWeight: 600, padding: '8px 16px',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {activeTab === 'terminated' && (
              <>
                <div className="controls" style={{ marginBottom: 12 }}>
                  <div className="field">
                    <label>Account</label>
                    <select value={termFilterAccount} onChange={e => setTermFilterAccount(e.target.value)}>
                      <option value="">All accounts</option>
                      {termAccounts.map(a => <option key={a} value={a}>{a}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label>Lifecycle</label>
                    <select value={termFilterLifecycle} onChange={e => setTermFilterLifecycle(e.target.value)}>
                      <option value="">All</option>
                      {termLifecycles.map(l => <option key={l} value={l}>{l}</option>)}
                    </select>
                  </div>
                  <button className="btn btn-ghost" onClick={exportTerminated} style={{ marginLeft: 'auto' }}>
                    Export CSV
                  </button>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Instance Name</th><th>Account</th><th>Lifecycle</th><th>Original Type</th>
                        <th>Monthly Cost</th><th>App Owner</th><th>Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredTerminated.map(r => (
                        <tr key={r.instanceId}>
                          <td style={{ fontWeight: 500 }}>{r.instanceName || r.instanceId}</td>
                          <td>{r.accountName || '—'}</td>
                          <td><span className={`badge ${lifecycleBadge(r.lifecycle)}`}>{r.lifecycle || '—'}</span></td>
                          <td style={{ fontSize: 12, color: 'var(--muted)' }}>{r.originalType || '—'}</td>
                          <td style={{ fontWeight: 600 }}>{fmtMoney(r.originalMonthlyCost)}</td>
                          <td style={{ fontSize: 12 }}>{r.appOwner || '—'}</td>
                          <td style={{ fontSize: 12, maxWidth: 200 }}>{r.notes || '—'}</td>
                        </tr>
                      ))}
                      {filteredTerminated.length === 0 && (
                        <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--muted)' }}>No terminated instances match these filters.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, marginTop: 12, textAlign: 'right' }}>
                  {filteredTerminated.length.toLocaleString()} instances · {fmtMoney(filteredTerminated.reduce((s, r) => s + r.originalMonthlyCost, 0))}/month recovered
                </div>
              </>
            )}

            {activeTab === 'rightsized' && (
              <>
                <div className="controls" style={{ marginBottom: 12 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                    <input type="checkbox" checked={rsDownsizeOnly} onChange={e => setRsDownsizeOnly(e.target.checked)} />
                    Show downsizes only
                  </label>
                  <button className="btn btn-ghost" onClick={exportRightsized} style={{ marginLeft: 'auto' }}>
                    Export CSV
                  </button>
                </div>
                <div className="alert alert-info">
                  Upsized instances may reflect intentional capacity additions — verify with app owner before flagging as a regression.
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Instance Name</th><th>Account</th><th>Lifecycle</th><th>Original Type</th>
                        <th>Current Type</th><th>Direction</th><th>Est. Monthly Savings</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRightsized.map(r => (
                        <tr key={r.instanceId} style={r.direction === 'upsize' ? { color: 'var(--muted)' } : undefined}>
                          <td style={{ fontWeight: 500 }}>{r.instanceName || r.instanceId}</td>
                          <td>{r.accountName || '—'}</td>
                          <td><span className={`badge ${lifecycleBadge(r.lifecycle)}`}>{r.lifecycle || '—'}</span></td>
                          <td style={{ fontSize: 12 }}>{r.originalType}</td>
                          <td style={{ fontSize: 12 }}>{r.currentType}</td>
                          <td>
                            <span className={`badge ${r.direction === 'downsize' ? 'badge-green' : 'badge-gray'}`}>
                              {r.direction === 'downsize' ? 'Downsize ↓' : 'Upsize ↑'}
                            </span>
                          </td>
                          <td style={{ fontWeight: 600 }}>
                            {r.estimatedSavings !== null ? fmtMoney(r.estimatedSavings) : 'Est. N/A'}
                          </td>
                        </tr>
                      ))}
                      {filteredRightsized.length === 0 && (
                        <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--muted)' }}>No rightsized instances match these filters.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {activeTab === 'unchanged' && (
              <>
                <div className="controls" style={{ marginBottom: 12 }}>
                  <div className="field">
                    <label>Lifecycle</label>
                    <select value={ucFilterLifecycle} onChange={e => setUcFilterLifecycle(e.target.value)}>
                      <option value="">All</option>
                      {ucLifecycles.map(l => <option key={l} value={l}>{l}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label>Account</label>
                    <select value={ucFilterAccount} onChange={e => setUcFilterAccount(e.target.value)}>
                      <option value="">All accounts</option>
                      {ucAccounts.map(a => <option key={a} value={a}>{a}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label>Product</label>
                    <select value={ucFilterProduct} onChange={e => setUcFilterProduct(e.target.value)}>
                      <option value="">All products</option>
                      {ucProducts.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>
                  {(ucFilterLifecycle || ucFilterAccount || ucFilterProduct) && (
                    <button className="btn btn-ghost" onClick={() => { setUcFilterLifecycle(''); setUcFilterAccount(''); setUcFilterProduct('') }}>
                      Clear filters
                    </button>
                  )}
                  <button className="btn btn-ghost" onClick={exportUnchanged} style={{ marginLeft: 'auto' }}>
                    Export CSV
                  </button>
                </div>
                <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
                  This is the work list for future optimization meetings. Defaults to DEV lifecycle — the primary rightsizing target.
                </p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Instance Name</th><th>Account</th><th>Lifecycle</th><th>Instance Type</th>
                        <th>Monthly Cost</th><th>App Owner</th><th>Product/Category</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredUnchanged.map(r => (
                        <tr key={r.instanceId}>
                          <td style={{ fontWeight: 500 }}>{r.instanceName || r.instanceId}</td>
                          <td>{r.accountName || '—'}</td>
                          <td><span className={`badge ${lifecycleBadge(r.lifecycle)}`}>{r.lifecycle || '—'}</span></td>
                          <td style={{ fontSize: 12, color: 'var(--muted)' }}>{r.apiName || '—'}</td>
                          <td style={{ fontWeight: 600 }}>{fmtMoney(r.monthlyCost)}</td>
                          <td style={{ fontSize: 12 }}>{r.appOwner || '—'}</td>
                          <td><span className="badge badge-gray">{r.product || '—'}</span></td>
                        </tr>
                      ))}
                      {filteredUnchanged.length === 0 && (
                        <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--muted)' }}>No unchanged instances match these filters.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, marginTop: 12, textAlign: 'right' }}>
                  {filteredUnchanged.length.toLocaleString()} instances · {fmtMoney(filteredUnchanged.reduce((s, r) => s + r.monthlyCost, 0))}/month remaining opportunity
                </div>
              </>
            )}
          </div>

          {/* Section 5 — MoM Progress */}
          {snapshots.length >= 2 && (
            <div className="card">
              <div className="card-title">Month-over-Month Progress</div>
              {trendLoading && <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading trend across {snapshots.length} snapshots…</p>}
              {!trendLoading && (
                <>
                  {firstTrend && lastTrend && firstTrend !== lastTrend && (
                    <p style={{ fontSize: 13, marginBottom: 16 }}>
                      Progress since first snapshot ({firstTrend.date}): {' '}
                      <strong style={{ color: 'var(--red)' }}>+{lastTrend.terminated - firstTrend.terminated} terminated</strong>
                      {', '}
                      <strong style={{ color: 'var(--blue)' }}>+{lastTrend.rightsized - firstTrend.rightsized} rightsized</strong>
                    </p>
                  )}
                  <div className="grid-2">
                    <div>
                      <div className="narrative-label">Terminated Count Over Time</div>
                      <div style={{ width: '100%', height: 220 }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={trendData} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                            <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                            <YAxis tick={{ fontSize: 11 }} width={40} />
                            <Tooltip />
                            <Line type="monotone" dataKey="terminated" stroke="var(--red)" strokeWidth={2} dot={{ r: 3 }} name="Terminated" />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                    <div>
                      <div className="narrative-label">Monthly Savings Realized</div>
                      <div style={{ width: '100%', height: 220 }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={trendData} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                            <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                            <YAxis tick={{ fontSize: 11 }} width={56} tickFormatter={v => `$${v}`} />
                            <Tooltip formatter={(v: unknown) => fmtMoney(Number(v ?? 0))} />
                            <Bar dataKey="savings" fill="var(--green)" name="Savings" />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </main>
  )
}
