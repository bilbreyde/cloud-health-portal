import { useEffect, useState } from 'react'
import { fetchReports } from '../api'
import CustomerSelector from '../components/CustomerSelector'
import type { Report } from '../types'

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

export default function History() {
  const [customerId, setCustomerId] = useState('')
  const [reports, setReports]       = useState<Report[]>([])
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState('')

  useEffect(() => {
    if (!customerId) { setReports([]); return }
    setLoading(true)
    setError('')
    fetchReports(customerId)
      .then(r => { setReports(r); setLoading(false) })
      .catch(e => { setError(String(e)); setLoading(false) })
  }, [customerId])

  function statusBadge(status: string) {
    if (status === 'final')  return <span className="badge badge-green">Final</span>
    if (status === 'review') return <span className="badge badge-yellow">Review</span>
    return <span className="badge badge-gray">Draft</span>
  }

  return (
    <main className="page">
      <h1 className="page-title">Report History</h1>

      <div className="card">
        <div className="controls">
          <CustomerSelector value={customerId} onChange={setCustomerId} />
        </div>
      </div>

      <div className="card">
        {!customerId && (
          <p style={{ color: 'var(--muted)' }}>Select a customer to view their report history.</p>
        )}
        {loading && <p style={{ color: 'var(--muted)' }}>Loading…</p>}
        {error && <div className="alert alert-error">{error}</div>}
        {customerId && !loading && !error && reports.length === 0 && (
          <p style={{ color: 'var(--muted)' }}>No reports found for this customer.</p>
        )}
        {reports.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Generated At</th>
                  <th>Status</th>
                  <th>Report ID</th>
                  <th>Joel's Notes</th>
                  <th>Download</th>
                </tr>
              </thead>
              <tbody>
                {reports.map(r => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>{MONTH_ABBR[r.month - 1]} {r.year}</td>
                    <td style={{ color: 'var(--muted)' }}>
                      {new Date(r.generatedAt).toLocaleString('en-US', {
                        month: 'short', day: 'numeric', year: 'numeric',
                        hour: '2-digit', minute: '2-digit',
                      })}
                    </td>
                    <td>{statusBadge(r.status)}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--muted)' }}>
                      {r.id.slice(0, 8)}…
                    </td>
                    <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--muted)' }}>
                      {r.joelNotes || '—'}
                    </td>
                    <td>
                      {r.blobPath ? (
                        <a href={r.blobPath} target="_blank" rel="noreferrer" className="btn btn-ghost" style={{ padding: '3px 10px', fontSize: 12 }}>
                          Download
                        </a>
                      ) : (
                        <span style={{ color: 'var(--muted)', fontSize: 12 }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  )
}
