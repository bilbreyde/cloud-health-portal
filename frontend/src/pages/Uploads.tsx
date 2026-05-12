import { useEffect, useState } from 'react'
import { fetchUploads, patchUpload } from '../api'
import { useCustomer } from '../context/CustomerContext'
import type { UploadRecord } from '../types'

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const SERVICE_TYPES = ['EC2','EBS','RDS','S3','ElastiCache','Redshift','OpenSearch','DynamoDB','Consolidated']

function fmtDate(iso: string): string {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  return `${MONTH_ABBR[parseInt(m, 10) - 1]} ${d}, ${y}`
}

function fmtMoney(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

interface RowState {
  editing: boolean
  draft: string
  saving: boolean
  error: string
}

export default function Uploads() {
  const { selectedCustomer } = useCustomer()
  const customerId = selectedCustomer?.id ?? ''
  const [uploads, setUploads] = useState<UploadRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [fetchError, setFetchError] = useState('')
  const [rows, setRows] = useState<Record<string, RowState>>({})

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

  function rowState(id: string): RowState {
    return rows[id] ?? { editing: false, draft: '', saving: false, error: '' }
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
          <div className="card-title">
            {uploads.length} upload{uploads.length !== 1 ? 's' : ''}
          </div>
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
                {uploads.map(upload => {
                  const rs = rowState(upload.id)
                  return (
                    <tr key={upload.id}>
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
                        {rs.editing ? (
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
                          <button
                            className="btn btn-ghost"
                            style={{ padding: '3px 12px', fontSize: 12 }}
                            onClick={() => startEdit(upload)}
                          >
                            Edit
                          </button>
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
