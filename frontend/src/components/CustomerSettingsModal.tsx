import { useState } from 'react'
import { updateCustomerCommitment } from '../api'
import type { CommitmentType, Customer } from '../types'

const COMMITMENT_TYPES: { value: CommitmentType; label: string }[] = [
  { value: 'None', label: 'None' },
  { value: 'EDP', label: 'EDP (Enterprise Discount Program)' },
  { value: 'SavingsPlan', label: 'Savings Plan' },
  { value: 'EnterpriseAgreement', label: 'Enterprise Agreement' },
]

function fmtMoney(n: number) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function CustomerSettingsModal({
  customer, onClose, onSaved,
}: { customer: Customer; onClose: () => void; onSaved: () => void }) {
  const existing = customer.settings?.commitment

  const [commitmentType, setCommitmentType] = useState<CommitmentType>(existing?.commitmentType ?? 'None')
  const [annualValue, setAnnualValue] = useState(String(existing?.commitmentAnnualValue ?? ''))
  const [termYears, setTermYears] = useState(String(existing?.commitmentTermYears ?? ''))
  const [startDate, setStartDate] = useState(existing?.commitmentStartDate ?? '')
  const [endDate, setEndDate] = useState(existing?.commitmentEndDate ?? '')
  const [discountRate, setDiscountRate] = useState(String(existing?.discountRate != null ? existing.discountRate * 100 : ''))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const annualNum = parseFloat(annualValue) || 0
  const monthlyObligation = annualNum > 0 ? annualNum / 12 : 0

  async function handleSave() {
    setSaving(true)
    setError('')
    try {
      const body: Record<string, unknown> = { commitmentType }
      if (commitmentType !== 'None') {
        if (annualValue) body.commitmentAnnualValue = annualNum
        if (termYears) body.commitmentTermYears = parseInt(termYears, 10)
        if (startDate) body.commitmentStartDate = startDate
        if (endDate) body.commitmentEndDate = endDate
        if (annualNum > 0) body.commitmentMonthlyObligation = Math.round(monthlyObligation * 100) / 100
        if (discountRate) body.discountRate = (parseFloat(discountRate) || 0) / 100
      }
      await updateCustomerCommitment(customer.id, body)
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: 'var(--surface)', borderRadius: 8, padding: 28,
        width: 440, maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,.2)',
      }}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Customer Settings</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 20 }}>{customer.name} — Commitment Context</div>

        <div className="field" style={{ marginBottom: 14 }}>
          <label>Commitment Type</label>
          <select value={commitmentType} onChange={e => setCommitmentType(e.target.value as CommitmentType)}>
            {COMMITMENT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>

        {commitmentType !== 'None' && (
          <>
            <div className="field" style={{ marginBottom: 14 }}>
              <label>Annual Commitment Value ($)</label>
              <input
                type="number" min="0" step="1000" value={annualValue}
                onChange={e => setAnnualValue(e.target.value)}
                placeholder="11000000"
              />
            </div>

            <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>Term (years)</label>
                <input type="number" min="1" step="1" value={termYears} onChange={e => setTermYears(e.target.value)} placeholder="3" />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Estimated Discount Rate (%)</label>
                <input type="number" min="0" max="100" step="1" value={discountRate} onChange={e => setDiscountRate(e.target.value)} placeholder="20" />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>Start Date</label>
                <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>End Date</label>
                <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
              </div>
            </div>

            <div style={{
              padding: '10px 12px', background: 'var(--bg)', borderRadius: 6,
              border: '1px solid var(--border)', marginBottom: 18, fontSize: 13,
            }}>
              Monthly Obligation (auto-calculated): <strong>{monthlyObligation > 0 ? fmtMoney(monthlyObligation) : '—'}</strong>
            </div>
          </>
        )}

        {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? <><span className="spinner" /> Saving…</> : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
