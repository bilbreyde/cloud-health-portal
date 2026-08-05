import { useEffect, useMemo, useState } from 'react'
import { deleteUpload, fetchUploads, patchUpload } from '../api'
import { useCustomer } from '../context/CustomerContext'
import type { UploadRecord } from '../types'

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']
const SERVICE_TYPES = ['EC2','EBS','RDS','S3','ElastiCache','Redshift','OpenSearch','DynamoDB','Consolidated']

function fmtDate(iso: string): string {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  return `${MONTH_ABBR[parseInt(m, 10) - 1]} ${d}, ${y}`
}

function fmtMoney(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function periodKey(month: number, year: number): string {
  return `${year}-${month}`
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M2 4h12M5.5 4V2.5A1.5 1.5 0 0 1 7 1h2a1.5 1.5 0 0 1 1.5 1.5V4M6.5 7.5v4M9.5 7.5v4M3.5 4l.6 8.4A1.5 1.5 0 0 0 5.6 13.9h4.8a1.5 1.5 0 0 0 1.5-1.5L12.5 4"
        stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  )
}

interface RowState {
  editing: boolean
  draft: string
  saving: boolean
  error: string
  confirmingDelete: boolean
  deleting: boolean
  fadingOut: boolean
}

const DEFAULT_ROW_STATE: RowState = {
  editing: false, draft: '', saving: false, error: '',
  confirmingDelete: false, deleting: false, fadingOut: false,
}

export default function Uploads() {
  const { selectedCustomer } = useCustomer()
  const customerId = selectedCustomer?.id ?? ''
  const [uploads, setUploads] = useState<UploadRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [fetchError, setFetchError] = useState('')
  const [rows, setRows] = useState<Record<string, RowState>>({})

  const [filterPeriod, setFilterPeriod] = useState('all')
  const [bulkConfirming, setBulkConfirming] = useState(false)
  const [bulkConfirmText, setBulkConfirmText] = useState('')
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null)
  const [bulkError, setBulkError] = useState('')

  useEffect(() => {
    if (!customerId) { setUploads([]); setRows({}); return }
    setLoading(true)
    setFetchError('')
    fetchUploads(customerId)
      .then(data => {
        setUploads(data)
        setRows({})
      })
      .catch(e => setFetchError(String(e)))
      .finally(() => setLoading(false))
  }, [customerId])

  useEffect(() => {
    setFilterPeriod('all')
    setBulkConfirming(false)
    setBulkConfirmText('')
    setBulkProgress(null)
    setBulkError('')
  }, [customerId])

  function rowState(id: string): RowState {
    return rows[id] ?? DEFAULT_ROW_STATE
  }

  function setRow(id: string, patch: Partial<RowState>) {
    setRows(prev => ({ ...prev, [id]: { ...rowState(id), ...patch } }))
  }

  function startEdit(upload: UploadRecord) {
    setRow(upload.id, { editing: true, draft: upload.serviceType, saving: false, error: '' })
  }

  function cancelEdit(id: string) {
    setRow(id, { editing: false, draft: '', saving: false, error: '' })
  }

  async function saveEdit(upload: UploadRecord) {
    const { draft } = rowState(upload.id)
    if (!draft || draft === upload.serviceType) { cancelEdit(upload.id); return }
    setRow(upload.id, { saving: true, error: '' })
    try {
      const updated = await patchUpload(upload.id, { customerId: upload.customerId, serviceType: draft })
      setUploads(prev => prev.map(u => u.id === updated.id ? updated : u))
      setRow(upload.id, { editing: false, draft: '', saving: false, error: '' })
    } catch (e) {
      setRow(upload.id, { saving: false, error: String(e) })
    }
  }

  function askDelete(id: string) {
    setRow(id, { confirmingDelete: true, error: '' })
  }

  function cancelDelete(id: string) {
    setRow(id, { confirmingDelete: false, error: '' })
  }

  async function confirmDelete(upload: UploadRecord) {
    setRow(upload.id, { deleting: true, error: '' })
    try {
      await deleteUpload(upload.id, upload.customerId)
      setRow(upload.id, { deleting: false, confirmingDelete: false, fadingOut: true })
      setTimeout(() => {
        setUploads(prev => prev.filter(u => u.id !== upload.id))
      }, 300)
    } catch (e) {
      setRow(upload.id, { deleting: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  // ── Period filter ────────────────────────────────────────────────────────
  const periods = useMemo(() => {
    const seen = new Map<string, { month: number; year: number }>()
    for (const u of uploads) seen.set(periodKey(u.month, u.year), { month: u.month, year: u.year })
    return [...seen.values()].sort((a, b) => b.year - a.year || b.month - a.month)
  }, [uploads])

  const selectedPeriod = filterPeriod !== 'all'
    ? periods.find(p => periodKey(p.month, p.year) === filterPeriod) ?? null
    : null
  const periodLabel = selectedPeriod ? `${MONTH_NAMES[selectedPeriod.month - 1]} ${selectedPeriod.year}` : ''

  const visibleUploads = filterPeriod === 'all'
    ? uploads
    : uploads.filter(u => periodKey(u.month, u.year) === filterPeriod)

  function openBulkConfirm() {
    setBulkConfirming(true)
    setBulkConfirmText('')
    setBulkError('')
  }

  function cancelBulk() {
    setBulkConfirming(false)
    setBulkConfirmText('')
    setBulkError('')
  }

  async function runBulkDelete() {
    if (!selectedPeriod) return
    const targets = visibleUploads
    setBulkError('')
    setBulkProgress({ done: 0, total: targets.length })
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]
      try {
        await deleteUpload(target.id, target.customerId)
        setUploads(prev => prev.filter(u => u.id !== target.id))
      } catch (e) {
        setBulkError(`Stopped after failing to delete "${target.fileName}": ${e instanceof Error ? e.message : String(e)}`)
        setBulkProgress(null)
        return
      }
      setBulkProgress({ done: i + 1, total: targets.length })
    }
    setBulkProgress(null)
    setBulkConfirming(false)
    setBulkConfirmText('')
    setFilterPeriod('all')
  }

  const bulkConfirmMatches = selectedPeriod !== null && bulkConfirmText.trim() === periodLabel

  return (
    <main className="page">
      <h1 className="page-title">Manage Uploads</h1>

      {loading && (
        <div className="card" style={{ textAlign: 'center', color: 'var(--muted)', padding: 32 }}>
          Loading uploads…
        </div>
      )}

      {fetchError && (
        <div className="card" style={{ color: 'var(--red)' }}>{fetchError}</div>
      )}

      {!loading && customerId && uploads.length === 0 && !fetchError && (
        <div className="card" style={{ textAlign: 'center', color: 'var(--muted)', padding: 32 }}>
          No uploads yet for this customer.
        </div>
      )}

      {!loading && uploads.length > 0 && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
            <div className="card-title" style={{ margin: 0 }}>
              {visibleUploads.length} upload{visibleUploads.length !== 1 ? 's' : ''}
              {selectedPeriod && <span style={{ fontWeight: 400, color: 'var(--muted)' }}> — {periodLabel}</span>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ fontSize: 12, color: 'var(--muted)' }}>Period</label>
              <select
                value={filterPeriod}
                onChange={e => { setFilterPeriod(e.target.value); cancelBulk() }}
                style={{ minWidth: 160 }}
              >
                <option value="all">All periods</option>
                {periods.map(p => (
                  <option key={periodKey(p.month, p.year)} value={periodKey(p.month, p.year)}>
                    {MONTH_NAMES[p.month - 1]} {p.year}
                  </option>
                ))}
              </select>
              {selectedPeriod && !bulkConfirming && !bulkProgress && (
                <button
                  className="btn btn-ghost"
                  style={{ padding: '4px 10px', fontSize: 12, color: 'var(--red)', borderColor: 'var(--red)' }}
                  onClick={openBulkConfirm}
                >
                  Delete all {visibleUploads.length} uploads for {periodLabel}
                </button>
              )}
            </div>
          </div>

          {bulkConfirming && selectedPeriod && (
            <div style={{
              display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px',
              background: '#FDE7E9', border: '1px solid #F4B8BD', borderRadius: 8, marginBottom: 14, fontSize: 13,
            }}>
              <div>
                This permanently deletes all <strong>{visibleUploads.length}</strong> uploads for <strong>{periodLabel}</strong> and
                their associated trend data. Type <strong>{periodLabel}</strong> to confirm.
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  value={bulkConfirmText}
                  onChange={e => setBulkConfirmText(e.target.value)}
                  placeholder={periodLabel}
                  style={{ minWidth: 200, fontSize: 13, padding: '5px 10px' }}
                  autoFocus
                />
                <button
                  className="btn btn-primary"
                  style={{ padding: '4px 12px', fontSize: 12, background: 'var(--red)', borderColor: 'var(--red)' }}
                  disabled={!bulkConfirmMatches}
                  onClick={runBulkDelete}
                >
                  Confirm Delete
                </button>
                <button className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={cancelBulk}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {bulkProgress && (
            <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>
              Deleting {bulkProgress.done} of {bulkProgress.total}…
            </div>
          )}

          {bulkError && (
            <div className="alert alert-error" style={{ marginBottom: 14, fontSize: 12 }}>{bulkError}</div>
          )}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Snapshot Date</th>
                  <th>File</th>
                  <th>Service Type</th>
                  <th>Period</th>
                  <th>Snap #</th>
                  <th>Savings Total</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleUploads.map(upload => {
                  const rs = rowState(upload.id)
                  return (
                    <tr key={upload.id} style={{ opacity: rs.fadingOut ? 0 : 1, transition: 'opacity 300ms' }}>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {fmtDate(upload.snapshotDate)}
                      </td>
                      <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          title={upload.fileName}>
                        {upload.fileName}
                      </td>
                      <td>
                        {rs.editing ? (
                          <select
                            value={rs.draft}
                            onChange={e => setRow(upload.id, { draft: e.target.value })}
                            disabled={rs.saving}
                            style={{ minWidth: 130 }}
                            autoFocus
                          >
                            {SERVICE_TYPES.map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        ) : (
                          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                            <span className="badge badge-blue">{upload.serviceType}</span>
                            {upload.isRelabeled && (
                              <span className="badge badge-yellow" title="Service type was manually corrected">
                                Relabeled
                              </span>
                            )}
                          </span>
                        )}
                        {rs.error && (
                          <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4 }}>{rs.error}</div>
                        )}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {MONTH_ABBR[upload.month - 1]} {upload.year}
                      </td>
                      <td style={{ color: 'var(--muted)', fontSize: 13 }}>
                        #{upload.snapshotNumber}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {upload.savingsTotal ? fmtMoney(upload.savingsTotal) : '—'}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {rs.confirmingDelete ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                            <span style={{ color: 'var(--muted)' }}>Delete this upload? This will also remove its trend data.</span>
                            <button
                              className="btn btn-primary"
                              style={{ padding: '3px 10px', fontSize: 12, background: 'var(--red)', borderColor: 'var(--red)' }}
                              onClick={() => confirmDelete(upload)}
                              disabled={rs.deleting}
                            >
                              {rs.deleting ? 'Deleting…' : 'Confirm'}
                            </button>
                            <button
                              className="btn btn-ghost"
                              style={{ padding: '3px 10px', fontSize: 12 }}
                              onClick={() => cancelDelete(upload.id)}
                              disabled={rs.deleting}
                            >
                              Cancel
                            </button>
                          </span>
                        ) : rs.editing ? (
                          <>
                            <button
                              className="btn btn-primary"
                              style={{ padding: '3px 12px', fontSize: 12, marginRight: 6 }}
                              onClick={() => saveEdit(upload)}
                              disabled={rs.saving}
                            >
                              {rs.saving ? 'Saving…' : 'Save'}
                            </button>
                            <button
                              className="btn btn-ghost"
                              style={{ padding: '3px 10px', fontSize: 12 }}
                              onClick={() => cancelEdit(upload.id)}
                              disabled={rs.saving}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <span style={{ display: 'inline-flex', gap: 6 }}>
                            <button
                              className="btn btn-ghost"
                              style={{ padding: '3px 12px', fontSize: 12 }}
                              onClick={() => startEdit(upload)}
                            >
                              Edit
                            </button>
                            <button
                              className="btn btn-ghost"
                              title="Delete upload"
                              aria-label="Delete upload"
                              style={{ padding: '3px 8px', fontSize: 12, color: 'var(--red)', borderColor: 'var(--red)' }}
                              onClick={() => askDelete(upload.id)}
                            >
                              <TrashIcon />
                            </button>
                          </span>
                        )}
                        {rs.error && !rs.confirmingDelete && (
                          <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4 }}>{rs.error}</div>
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
