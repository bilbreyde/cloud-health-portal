import { useCallback, useEffect, useRef, useState } from 'react'
import {
  deleteException,
  fetchExceptions,
  fetchExceptionSummary,
  importExceptions,
  putException,
} from '../api'
import CustomerSelector from '../components/CustomerSelector'
import type { ExceptionRecord, ExceptionSummary } from '../types'

function fmtMoney(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
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

function exportCsv(rows: ExceptionRecord[]): void {
  const headers = [
    'Instance Name', 'Instance ID', 'Account', 'App Owner', 'Product', 'Category',
    'Lifecycle', 'State', 'API Name', 'Server Role', 'Portfolio',
    'Price/hr', 'Monthly Cost', 'Notes',
  ]
  const escape = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const lines = [
    headers.map(escape).join(','),
    ...rows.map(e => [
      e.instanceName, e.instanceId, e.accountName, e.appOwner, e.product, e.exceptionCategory,
      e.lifecycle, e.state, e.apiName, e.serverRole, e.portfolioName,
      e.pricePerHour, e.projectedCostPerMonth, e.notes,
    ].map(escape).join(',')),
  ]
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'exceptions.csv'
  a.click()
  URL.revokeObjectURL(url)
}

interface EditState {
  notes: string
  category: string
  saving: boolean
  error: string
}

export default function Exceptions() {
  const [customerId, setCustomerId] = useState('')
  const [exceptions, setExceptions] = useState<ExceptionRecord[]>([])
  const [summary, setSummary] = useState<ExceptionSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [fetchError, setFetchError] = useState('')

  const [filterCategory, setFilterCategory] = useState('')
  const [filterLifecycle, setFilterLifecycle] = useState('')
  const [filterState, setFilterState] = useState('')

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editState, setEditState] = useState<EditState>({ notes: '', category: '', saving: false, error: '' })

  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const load = useCallback((cid: string) => {
    if (!cid) { setExceptions([]); setSummary(null); return }
    setLoading(true)
    setFetchError('')
    Promise.all([fetchExceptions(cid), fetchExceptionSummary(cid)])
      .then(([excs, summ]) => { setExceptions(excs); setSummary(summ) })
      .catch(e => setFetchError(String(e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load(customerId) }, [customerId, load])

  const categories = [...new Set(exceptions.map(e => e.exceptionCategory).filter(Boolean))].sort()
  const lifecycles = [...new Set(exceptions.map(e => e.lifecycle).filter(Boolean))].sort()
  const states = [...new Set(exceptions.map(e => e.state).filter(Boolean))].sort()

  const filtered = exceptions.filter(e => {
    if (filterCategory && e.exceptionCategory !== filterCategory) return false
    if (filterLifecycle && e.lifecycle !== filterLifecycle) return false
    if (filterState && e.state.toLowerCase() !== filterState.toLowerCase()) return false
    return true
  })

  function startEdit(exc: ExceptionRecord) {
    setEditingId(exc.id)
    setEditState({ notes: exc.notes, category: exc.exceptionCategory, saving: false, error: '' })
  }

  function cancelEdit() { setEditingId(null) }

  async function saveEdit(exc: ExceptionRecord) {
    setEditState(s => ({ ...s, saving: true, error: '' }))
    try {
      const updated = await putException(customerId, exc.id, {
        notes: editState.notes,
        exceptionCategory: editState.category,
      })
      setExceptions(prev => prev.map(e => e.id === updated.id ? updated : e))
      setEditingId(null)
      load(customerId)
    } catch (e) {
      setEditState(s => ({ ...s, saving: false, error: String(e) }))
    }
  }

  async function handleDelete(exc: ExceptionRecord) {
    if (!confirm(`Remove ${exc.instanceName} from exceptions?`)) return
    try {
      await deleteException(customerId, exc.id)
      setExceptions(prev => prev.filter(e => e.id !== exc.id))
      load(customerId)
    } catch (e) {
      alert(String(e))
    }
  }

  async function handleFileImport(file: File) {
    setImporting(true)
    setImportMsg('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      const result = await importExceptions(customerId, fd)
      setImportMsg(`Imported ${result.imported} exceptions${result.errors.length ? ` (${result.errors.length} errors)` : ''}`)
      load(customerId)
    } catch (e) {
      setImportMsg(`Error: ${String(e)}`)
    } finally {
      setImporting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  return (
    <main className="page">
      <h1 className="page-title">Exceptions</h1>

      <div className="card">
        <div className="controls">
          <CustomerSelector value={customerId} onChange={id => { setCustomerId(id); setFilterCategory(''); setFilterLifecycle(''); setFilterState('') }} />
          {customerId && (
            <>
              <input
                type="file"
                accept=".xlsx,.csv"
                ref={fileInputRef}
                style={{ display: 'none' }}
                onChange={e => { if (e.target.files?.[0]) handleFileImport(e.target.files[0]) }}
              />
              <button
                className="btn btn-secondary"
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
                style={{ alignSelf: 'flex-end' }}
              >
                {importing ? 'Importing…' : 'Import Exceptions'}
              </button>
              {filtered.length > 0 && (
                <button
                  className="btn btn-ghost"
                  onClick={() => exportCsv(filtered)}
                  style={{ alignSelf: 'flex-end' }}
                >
                  Export CSV
                </button>
              )}
            </>
          )}
        </div>
        {importMsg && (
          <div className={`alert ${importMsg.startsWith('Error') ? 'alert-error' : 'alert-success'}`}>
            {importMsg}
          </div>
        )}
      </div>

      {/* Summary cards */}
      {summary && summary.totalCount > 0 && (
        <div className="grid-2" style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 20 }}>
          <div className="card" style={{ margin: 0, textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--blue)' }}>{summary.totalCount}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>Total Exceptions</div>
          </div>
          <div className="card" style={{ margin: 0, textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--red)' }}>
              {fmtMoney(summary.totalMonthlyCost)}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>Exception Floor / Month</div>
          </div>
          <div className="card" style={{ margin: 0, textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text)' }}>
              {summary.byCategory.length}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>Categories</div>
          </div>
        </div>
      )}

      {/* Breakdown row */}
      {summary && summary.totalCount > 0 && (
        <div className="grid-2" style={{ marginBottom: 20 }}>
          <div className="card" style={{ margin: 0 }}>
            <div className="card-title">By Category</div>
            <table>
              <thead><tr><th>Category</th><th>Count</th><th>Monthly Cost</th></tr></thead>
              <tbody>
                {summary.byCategory.map(r => (
                  <tr key={r.category}>
                    <td>{r.category}</td>
                    <td>{r.count}</td>
                    <td>{fmtMoney(r.monthlyCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card" style={{ margin: 0 }}>
            <div className="card-title">By Lifecycle</div>
            <table>
              <thead><tr><th>Lifecycle</th><th>Count</th><th>Monthly Cost</th></tr></thead>
              <tbody>
                {summary.byLifecycle.map(r => (
                  <tr key={r.lifecycle}>
                    <td><span className={`badge ${lifecycleBadge(r.lifecycle)}`}>{r.lifecycle}</span></td>
                    <td>{r.count}</td>
                    <td>{fmtMoney(r.monthlyCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {loading && (
        <div className="card" style={{ textAlign: 'center', color: 'var(--muted)', padding: 32 }}>
          Loading exceptions…
        </div>
      )}

      {fetchError && <div className="card" style={{ color: 'var(--red)' }}>{fetchError}</div>}

      {!loading && customerId && exceptions.length === 0 && !fetchError && (
        <div className="card" style={{ textAlign: 'center', color: 'var(--muted)', padding: 32 }}>
          No exceptions on file for this customer. Use "Import Exceptions" to load from xlsx or csv.
        </div>
      )}

      {!loading && exceptions.length > 0 && (
        <div className="card">
          {/* Filter bar */}
          <div className="controls" style={{ marginBottom: 16 }}>
            <div className="field">
              <label>Category</label>
              <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} style={{ minWidth: 160 }}>
                <option value="">All categories</option>
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Lifecycle</label>
              <select value={filterLifecycle} onChange={e => setFilterLifecycle(e.target.value)} style={{ minWidth: 120 }}>
                <option value="">All</option>
                {lifecycles.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
            <div className="field">
              <label>State</label>
              <select value={filterState} onChange={e => setFilterState(e.target.value)} style={{ minWidth: 120 }}>
                <option value="">All</option>
                {states.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            {(filterCategory || filterLifecycle || filterState) && (
              <button
                className="btn btn-ghost"
                style={{ alignSelf: 'flex-end', padding: '6px 12px', fontSize: 12 }}
                onClick={() => { setFilterCategory(''); setFilterLifecycle(''); setFilterState('') }}
              >
                Clear filters
              </button>
            )}
          </div>

          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
            {filtered.length} of {exceptions.length} exception{exceptions.length !== 1 ? 's' : ''}
            {' '}· {fmtMoney(filtered.reduce((s, e) => s + e.projectedCostPerMonth, 0))} / month
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Instance Name</th>
                  <th>Product / Category</th>
                  <th>Lifecycle</th>
                  <th>Instance Type</th>
                  <th>Monthly Cost</th>
                  <th>App Owner</th>
                  <th>Notes</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(exc => {
                  const isEditing = editingId === exc.id
                  return (
                    <tr key={exc.id}>
                      <td>
                        <div style={{ fontWeight: 500 }}>{exc.instanceName || exc.instanceId}</div>
                        {exc.instanceName && exc.instanceId && (
                          <div style={{ fontSize: 11, color: 'var(--muted)' }}>{exc.instanceId}</div>
                        )}
                      </td>
                      <td>
                        <div style={{ fontSize: 12 }}>{exc.product}</div>
                        {isEditing ? (
                          <input
                            type="text"
                            value={editState.category}
                            onChange={e => setEditState(s => ({ ...s, category: e.target.value }))}
                            style={{ marginTop: 4, width: 150, fontSize: 11 }}
                          />
                        ) : (
                          <span className="badge badge-gray" style={{ marginTop: 2 }}>{exc.exceptionCategory}</span>
                        )}
                      </td>
                      <td>
                        <span className={`badge ${lifecycleBadge(exc.lifecycle)}`}>{exc.lifecycle || '—'}</span>
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--muted)' }}>{exc.apiName || '—'}</td>
                      <td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>
                        {exc.projectedCostPerMonth ? fmtMoney(exc.projectedCostPerMonth) : '—'}
                      </td>
                      <td style={{ fontSize: 12 }}>{exc.appOwner || '—'}</td>
                      <td style={{ maxWidth: 220 }}>
                        {isEditing ? (
                          <textarea
                            value={editState.notes}
                            onChange={e => setEditState(s => ({ ...s, notes: e.target.value }))}
                            style={{ width: '100%', minHeight: 60, fontSize: 12, resize: 'vertical' }}
                          />
                        ) : (
                          <span style={{ fontSize: 12, color: exc.notes ? 'var(--text)' : 'var(--muted)' }}>
                            {exc.notes || '—'}
                          </span>
                        )}
                        {isEditing && editState.error && (
                          <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4 }}>{editState.error}</div>
                        )}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {isEditing ? (
                          <>
                            <button
                              className="btn btn-primary"
                              style={{ padding: '3px 10px', fontSize: 11, marginRight: 4 }}
                              onClick={() => saveEdit(exc)}
                              disabled={editState.saving}
                            >
                              {editState.saving ? 'Saving…' : 'Save'}
                            </button>
                            <button
                              className="btn btn-ghost"
                              style={{ padding: '3px 8px', fontSize: 11 }}
                              onClick={cancelEdit}
                              disabled={editState.saving}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className="btn btn-ghost"
                              style={{ padding: '3px 10px', fontSize: 11, marginRight: 4 }}
                              onClick={() => startEdit(exc)}
                            >
                              Edit
                            </button>
                            <button
                              className="btn btn-ghost"
                              style={{ padding: '3px 8px', fontSize: 11, color: 'var(--red)', borderColor: 'var(--red)' }}
                              onClick={() => handleDelete(exc)}
                            >
                              ×
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </main>
  )
}
