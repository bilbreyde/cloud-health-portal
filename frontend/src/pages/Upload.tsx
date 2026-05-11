import { useEffect, useRef, useState } from 'react'
import { fetchTrends, uploadCsv } from '../api'
import CustomerSelector from '../components/CustomerSelector'
import type { UploadResult } from '../types'

const MONTH_ABBR = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December']

const SERVICE_MAP: [string, string][] = [
  ['elasticache', 'ElastiCache'], ['opensearch', 'OpenSearch'],
  ['elasticsearch', 'OpenSearch'], ['dynamodb', 'DynamoDB'],
  ['redshift', 'Redshift'], ['ec2', 'EC2'], ['rds', 'RDS'],
  ['ebs', 'EBS'], ['s3', 'S3'],
]

function detectServiceType(filename: string): string {
  const lower = filename.toLowerCase()
  for (const [kw, svc] of SERVICE_MAP) {
    if (lower.includes(kw)) return svc
  }
  return 'Consolidated'
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

interface FileEntry {
  file: File
  serviceType: string
  status: 'pending' | 'uploading' | 'done' | 'error'
  result?: UploadResult
  errorMsg?: string
}

function now() { const d = new Date(); return { month: d.getMonth() + 1, year: d.getFullYear() } }

export default function Upload() {
  const today = now()
  const [customerId, setCustomerId] = useState('')
  const [month, setMonth] = useState(today.month)
  const [year, setYear] = useState(2026)
  const [snapshotDate, setSnapshotDate] = useState(todayIso())
  const [snapshotsByService, setSnapshotsByService] = useState<Record<string, number>>({})
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Fetch existing snapshot counts whenever customer/month/year changes
  useEffect(() => {
    if (!customerId) { setSnapshotsByService({}); return }
    let cancelled = false
    fetchTrends(customerId, { startMonth: month, startYear: year, endMonth: month, endYear: year })
      .then(data => {
        if (cancelled) return
        const counts: Record<string, number> = {}
        for (const s of data.snapshots_detail ?? []) {
          counts[s.serviceType] = (counts[s.serviceType] ?? 0) + 1
        }
        setSnapshotsByService(counts)
      })
      .catch(() => { if (!cancelled) setSnapshotsByService({}) })
    return () => { cancelled = true }
  }, [customerId, month, year])

  function addFiles(files: FileList | File[]) {
    const arr = Array.from(files).filter(f => f.name.endsWith('.csv'))
    if (!arr.length) return
    setEntries(prev => [
      ...prev,
      ...arr.map(f => ({
        file: f,
        serviceType: detectServiceType(f.name),
        status: 'pending' as const,
      })),
    ])
  }

  function removeEntry(idx: number) {
    setEntries(prev => prev.filter((_, i) => i !== idx))
  }

  function updateServiceType(idx: number, svc: string) {
    setEntries(prev => prev.map((e, i) => i === idx ? { ...e, serviceType: svc } : e))
  }

  // Snapshot number = existing for this service + how many of the same service
  // type appear before this entry in the current batch + 1
  function getSnapshotNum(idx: number): number {
    const svc = entries[idx].serviceType
    const existing = snapshotsByService[svc] ?? 0
    const batchBefore = entries.slice(0, idx).filter(e => e.serviceType === svc).length
    return existing + batchBefore + 1
  }

  async function uploadAll() {
    if (!customerId || !entries.length) return
    setUploading(true)

    const updated = [...entries]
    for (let i = 0; i < updated.length; i++) {
      if (updated[i].status === 'done') continue
      updated[i] = { ...updated[i], status: 'uploading' }
      setEntries([...updated])

      const fd = new FormData()
      fd.append('file', updated[i].file)
      fd.append('customerId', customerId)
      fd.append('month', String(month))
      fd.append('year', String(year))
      fd.append('serviceType', updated[i].serviceType)
      fd.append('snapshotDate', snapshotDate)

      try {
        const result = await uploadCsv(fd)
        updated[i] = { ...updated[i], status: 'done', result }
      } catch (e) {
        updated[i] = { ...updated[i], status: 'error', errorMsg: String(e) }
      }
      setEntries([...updated])
    }

    // Refresh snapshot counts after uploads complete
    if (customerId) {
      fetchTrends(customerId, { startMonth: month, startYear: year, endMonth: month, endYear: year })
        .then(data => {
          const counts: Record<string, number> = {}
          for (const s of data.snapshots_detail ?? []) {
            counts[s.serviceType] = (counts[s.serviceType] ?? 0) + 1
          }
          setSnapshotsByService(counts)
        })
        .catch(() => {})
    }

    setUploading(false)
  }

  const svcs = ['EC2','RDS','S3','EBS','ElastiCache','Redshift','OpenSearch','DynamoDB','Consolidated']
  const pendingCount = entries.filter(e => e.status === 'pending').length
  const totalExisting = Object.values(snapshotsByService).reduce((a, b) => a + b, 0)
  const monthName = MONTH_ABBR[month - 1]

  return (
    <main className="page">
      <h1 className="page-title">Upload CSVs</h1>

      <div className="card">
        <div className="controls">
          <CustomerSelector value={customerId} onChange={setCustomerId} />
          <div className="field">
            <label>Month</label>
            <select value={month} onChange={e => { setMonth(+e.target.value); setEntries([]) }}>
              {MONTH_ABBR.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Year</label>
            <select value={year} onChange={e => { setYear(+e.target.value); setEntries([]) }}>
              {[2026, 2027, 2028].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Report Date (snapshot date)</label>
            <input
              type="date"
              value={snapshotDate}
              max={todayIso()}
              onChange={e => setSnapshotDate(e.target.value)}
              style={{ fontFamily: 'inherit', fontSize: 14, padding: '5px 8px',
                       border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)' }}
            />
          </div>
        </div>

        {customerId && (
          <div style={{
            marginTop: 12, fontSize: 13,
            color: totalExisting > 0 ? 'var(--blue, #3b82f6)' : 'var(--muted)',
          }}>
            {totalExisting > 0
              ? `${totalExisting} snapshot${totalExisting !== 1 ? 's' : ''} already on file for ${monthName} ${year}`
              : `No snapshots yet for ${monthName} ${year}`}
          </div>
        )}
      </div>

      <div className="card">
        <div
          className={`dropzone${dragOver ? ' over' : ''}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files) }}
        >
          <input ref={inputRef} type="file" accept=".csv" multiple
            onChange={e => e.target.files && addFiles(e.target.files)} />
          <div style={{ fontSize: 28, marginBottom: 8 }}>⬆</div>
          <div style={{ fontWeight: 600 }}>Drop CSV files here or click to browse</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Accepts .csv files only — service type is auto-detected from filename</div>
        </div>
      </div>

      {entries.length > 0 && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div className="card-title" style={{ margin: 0 }}>Files ({entries.length})</div>
            <button
              className="btn btn-primary"
              onClick={uploadAll}
              disabled={!customerId || uploading || pendingCount === 0}
            >
              {uploading ? <><span className="spinner" /> Uploading…</> : `Upload ${pendingCount} file${pendingCount !== 1 ? 's' : ''}`}
            </button>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Size</th>
                  <th>Service Type</th>
                  <th>Snapshot #</th>
                  <th>Status</th>
                  <th>Savings Total</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, i) => (
                  <tr key={`${entry.file.name}-${i}`}>
                    <td style={{ fontWeight: 500 }}>{entry.file.name}</td>
                    <td style={{ color: 'var(--muted)' }}>{(entry.file.size / 1024).toFixed(1)} KB</td>
                    <td>
                      {entry.status === 'pending' ? (
                        <select value={entry.serviceType} onChange={e => updateServiceType(i, e.target.value)} style={{ minWidth: 130 }}>
                          {svcs.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      ) : (
                        <span className="badge badge-blue">{entry.serviceType}</span>
                      )}
                    </td>
                    <td style={{ color: 'var(--muted)', fontSize: 13, whiteSpace: 'nowrap' }}>
                      {entry.result?.snapshotNumber != null
                        ? <span className="badge badge-blue">#{entry.result.snapshotNumber}</span>
                        : <span style={{ color: 'var(--muted)' }}>#{getSnapshotNum(i)}</span>}
                    </td>
                    <td>
                      {entry.status === 'pending' && <span className="badge badge-gray">Pending</span>}
                      {entry.status === 'uploading' && <span className="badge badge-yellow">Uploading…</span>}
                      {entry.status === 'done' && <span className="badge badge-green">Done</span>}
                      {entry.status === 'error' && <span className="badge badge-red" title={entry.errorMsg}>Error</span>}
                    </td>
                    <td>
                      {entry.result
                        ? `$${entry.result.savingsTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
                        : entry.errorMsg
                          ? <span style={{ color: 'var(--red)', fontSize: 12 }}>{entry.errorMsg}</span>
                          : '—'}
                    </td>
                    <td>
                      {entry.status === 'pending' && (
                        <button className="btn btn-ghost" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => removeEntry(i)}>✕</button>
                      )}
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
