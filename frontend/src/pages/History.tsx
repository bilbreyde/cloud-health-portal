import { useEffect, useRef, useState } from 'react'
import { fetchReports, importReport } from '../api'
import CustomerSelector from '../components/CustomerSelector'
import type { ExtractedReportData, Report } from '../types'

const MONTH_NAMES = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December']
const MONTH_ABBR  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function fmtMoney(n: number) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function statusBadge(status: string, source?: string) {
  if (source === 'manual_import') return <span className="badge badge-blue">Imported</span>
  if (status === 'final')  return <span className="badge badge-green">Final</span>
  if (status === 'review') return <span className="badge badge-yellow">Review</span>
  return <span className="badge badge-gray">Draft</span>
}

function ExtractedSummary({ data }: { data: ExtractedReportData }) {
  const savingsEntries = Object.entries(data.monthlySavings)
  return (
    <div style={{ padding: '12px 16px', background: 'var(--bg)', borderRadius: 4, fontSize: 13 }}>
      {savingsEntries.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.5px' }}>
            Monthly Savings Signal
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {savingsEntries.map(([svc, amt]) => (
              <span key={svc} className="badge badge-gray">{svc}: {fmtMoney(amt)}</span>
            ))}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: data.nextSteps.length > 0 ? 10 : 0 }}>
        {data.realizedSavings > 0 && (
          <span><strong>Realized Savings:</strong> {fmtMoney(data.realizedSavings)}</span>
        )}
        {data.exceptionFloor > 0 && (
          <span><strong>Exception Floor:</strong> {fmtMoney(data.exceptionFloor)}</span>
        )}
        {data.topMoversUp.length > 0 && (
          <span><strong>Top Movers Up:</strong> {data.topMoversUp.map(m => m.serviceType).join(', ')}</span>
        )}
        {data.topMoversDown.length > 0 && (
          <span><strong>Top Movers Down:</strong> {data.topMoversDown.map(m => m.serviceType).join(', ')}</span>
        )}
      </div>
      {data.nextSteps.length > 0 && (
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.5px' }}>
            Next Steps ({data.nextSteps.length})
          </div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {data.nextSteps.slice(0, 5).map((s, i) => <li key={i}>{s}</li>)}
            {data.nextSteps.length > 5 && <li style={{ color: 'var(--muted)' }}>…{data.nextSteps.length - 5} more</li>}
          </ul>
        </div>
      )}
    </div>
  )
}

interface ImportForm {
  month: number
  year: number
  reportDate: string
}

export default function History() {
  const today = new Date()
  const [customerId, setCustomerId] = useState('')
  const [reports, setReports]       = useState<Report[]>([])
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Import modal state
  const [showModal, setShowModal]   = useState(false)
  const [importForm, setImportForm] = useState<ImportForm>({
    month: today.getMonth() + 1,
    year: today.getFullYear(),
    reportDate: today.toISOString().slice(0, 10),
  })
  const [importing, setImporting]   = useState(false)
  const [importError, setImportError] = useState('')
  const [importSuccess, setImportSuccess] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  function loadReports(cid: string) {
    if (!cid) { setReports([]); return }
    setLoading(true)
    setError('')
    fetchReports(cid)
      .then(r => { setReports(r); setLoading(false) })
      .catch(e => { setError(String(e)); setLoading(false) })
  }

  useEffect(() => { loadReports(customerId) }, [customerId])

  async function handleImport() {
    const file = fileInputRef.current?.files?.[0]
    if (!file) { setImportError('Please select a .docx file'); return }
    if (!customerId) { setImportError('Please select a customer first'); return }

    setImporting(true)
    setImportError('')
    setImportSuccess('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('month', String(importForm.month))
      fd.append('year', String(importForm.year))
      fd.append('reportDate', importForm.reportDate)
      const result = await importReport(customerId, fd)

      const monthLabel = MONTH_ABBR[importForm.month - 1]
      const extracted = result.extractedData
      const savingsCount = Object.keys(extracted.monthlySavings).length
      const stepsCount = extracted.nextSteps.length
      setImportSuccess(
        `Imported ${monthLabel} ${importForm.year} report. ` +
        `Extracted: ${savingsCount} service savings, ${stepsCount} next steps.`
      )
      if (fileInputRef.current) fileInputRef.current.value = ''
      loadReports(customerId)
    } catch (e) {
      setImportError(String(e))
    } finally {
      setImporting(false)
    }
  }

  function closeModal() {
    setShowModal(false)
    setImportError('')
    setImportSuccess('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <main className="page">
      <h1 className="page-title">Report History</h1>

      <div className="card">
        <div className="controls">
          <CustomerSelector value={customerId} onChange={id => { setCustomerId(id); setExpandedId(null) }} />
          {customerId && (
            <button
              className="btn btn-secondary"
              style={{ alignSelf: 'flex-end' }}
              onClick={() => { setShowModal(true); setImportError(''); setImportSuccess('') }}
            >
              Import Past Report
            </button>
          )}
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
                  <th>Date</th>
                  <th>Status</th>
                  <th>Report ID</th>
                  <th>Notes / Data</th>
                  <th>File</th>
                </tr>
              </thead>
              <tbody>
                {reports.map(r => (
                  <>
                    <tr
                      key={r.id}
                      style={{ cursor: r.source === 'manual_import' ? 'pointer' : undefined }}
                      onClick={() => r.source === 'manual_import'
                        ? setExpandedId(prev => prev === r.id ? null : r.id)
                        : undefined}
                    >
                      <td style={{ fontWeight: 600 }}>{MONTH_ABBR[r.month - 1]} {r.year}</td>
                      <td style={{ color: 'var(--muted)' }}>
                        {new Date(r.generatedAt).toLocaleString('en-US', {
                          month: 'short', day: 'numeric', year: 'numeric',
                          hour: '2-digit', minute: '2-digit',
                        })}
                      </td>
                      <td>{statusBadge(r.status, r.source)}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--muted)' }}>
                        {r.id.slice(0, 8)}…
                      </td>
                      <td style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--muted)' }}>
                        {r.source === 'manual_import'
                          ? <span style={{ color: 'var(--blue)', fontSize: 12 }}>
                              {expandedId === r.id ? '▲ Hide extracted data' : '▼ View extracted data'}
                            </span>
                          : (r.joelNotes || '—')}
                      </td>
                      <td>
                        {r.blobPath ? (
                          <a href={`https://chp-dev-func.azurewebsites.net/api/blob/${r.blobPath}`}
                             target="_blank" rel="noreferrer"
                             className="btn btn-ghost"
                             style={{ padding: '3px 10px', fontSize: 12 }}
                             onClick={e => e.stopPropagation()}>
                            Download
                          </a>
                        ) : (
                          <span style={{ color: 'var(--muted)', fontSize: 12 }}>—</span>
                        )}
                      </td>
                    </tr>
                    {expandedId === r.id && r.extractedData && (
                      <tr key={`${r.id}-detail`}>
                        <td colSpan={6} style={{ padding: '8px 12px', background: 'var(--bg)' }}>
                          <ExtractedSummary data={r.extractedData} />
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Import Modal */}
      {showModal && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
          }}
          onClick={e => { if (e.target === e.currentTarget) closeModal() }}
        >
          <div style={{
            background: 'var(--surface)', borderRadius: 8, padding: 28,
            width: 480, boxShadow: '0 8px 32px rgba(0,0,0,.2)',
          }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 20 }}>Import Past Report</div>

            <div className="field" style={{ marginBottom: 14 }}>
              <label>Reporting Month</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <select
                  value={importForm.month}
                  onChange={e => setImportForm(f => ({ ...f, month: +e.target.value }))}
                  style={{ flex: 1 }}
                >
                  {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
                <select
                  value={importForm.year}
                  onChange={e => setImportForm(f => ({ ...f, year: +e.target.value }))}
                  style={{ width: 90 }}
                >
                  {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            </div>

            <div className="field" style={{ marginBottom: 14 }}>
              <label>Report Date</label>
              <input
                type="date"
                value={importForm.reportDate}
                max={today.toISOString().slice(0, 10)}
                onChange={e => setImportForm(f => ({ ...f, reportDate: e.target.value }))}
              />
            </div>

            <div className="field" style={{ marginBottom: 20 }}>
              <label>.docx File</label>
              <input
                type="file"
                accept=".docx"
                ref={fileInputRef}
                style={{
                  border: '1px solid var(--border)', borderRadius: 6,
                  padding: '6px 10px', width: '100%',
                }}
              />
            </div>

            {importError && <div className="alert alert-error" style={{ marginBottom: 12 }}>{importError}</div>}
            {importSuccess && <div className="alert alert-success" style={{ marginBottom: 12 }}>{importSuccess}</div>}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={closeModal} disabled={importing}>Cancel</button>
              <button className="btn btn-primary" onClick={handleImport} disabled={importing}>
                {importing ? <><span className="spinner" /> Importing…</> : 'Import Report'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
