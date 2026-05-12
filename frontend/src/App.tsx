import { useEffect, useRef, useState } from 'react'
import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom'
import { createCustomer } from './api'
import { useCustomer } from './context/CustomerContext'
import Dashboard from './pages/Dashboard'
import Exceptions from './pages/Exceptions'
import History from './pages/History'
import ReportBuilder from './pages/ReportBuilder'
import Upload from './pages/Upload'
import Uploads from './pages/Uploads'
import type { Customer } from './types'

function NewCustomerModal({ onClose, onCreated }: {
  onClose: () => void
  onCreated: (c: Customer) => void
}) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function deriveSlug(n: string) {
    return n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !slug.trim()) return
    setSaving(true)
    setError('')
    try {
      const customer = await createCustomer({ name: name.trim(), slug: slug.trim() })
      onCreated(customer)
    } catch (err) {
      setError(String(err))
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
        width: 400, boxShadow: '0 8px 32px rgba(0,0,0,.2)',
      }}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 20 }}>New Customer</div>
        <form onSubmit={handleSubmit}>
          <div className="field" style={{ marginBottom: 14 }}>
            <label>Customer Name</label>
            <input
              type="text"
              value={name}
              autoFocus
              onChange={e => {
                setName(e.target.value)
                setSlug(deriveSlug(e.target.value))
              }}
              placeholder="Acme Corp"
              required
            />
          </div>
          <div className="field" style={{ marginBottom: 20 }}>
            <label>Slug (URL-safe ID)</label>
            <input
              type="text"
              value={slug}
              onChange={e => setSlug(e.target.value)}
              placeholder="acme-corp"
              pattern="[a-z0-9-]+"
              required
            />
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
              Lowercase letters, numbers, hyphens only
            </div>
          </div>
          {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={saving || !name.trim() || !slug.trim()}
            >
              {saving ? 'Creating…' : 'Create Customer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function CustomerPill() {
  const { customers, selectedCustomer, setSelectedCustomer, refreshCustomers } = useCustomer()
  const [open, setOpen] = useState(false)
  const [showNewModal, setShowNewModal] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <>
      <div ref={ref} style={{ position: 'relative' }}>
        <button
          onClick={() => setOpen(o => !o)}
          style={{
            background: 'rgba(255,255,255,.12)', border: '1px solid rgba(255,255,255,.25)',
            borderRadius: 20, padding: '4px 14px', cursor: 'pointer',
            color: '#fff', fontSize: 13, fontWeight: 600,
            display: 'flex', alignItems: 'center', gap: 6,
          }}
        >
          <span>{selectedCustomer?.name ?? 'Select customer'}</span>
          <span style={{ fontSize: 10, opacity: .7 }}>▼</span>
        </button>
        {open && (
          <div style={{
            position: 'absolute', right: 0, top: 'calc(100% + 6px)',
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,.15)',
            minWidth: 200, zIndex: 200, overflow: 'hidden',
          }}>
            {customers.map(c => (
              <button
                key={c.id}
                onClick={() => { setSelectedCustomer(c); setOpen(false) }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '9px 16px', cursor: 'pointer', fontSize: 13,
                  background: c.id === selectedCustomer?.id ? 'var(--bg)' : 'transparent',
                  border: 'none', color: 'var(--text)',
                  fontWeight: c.id === selectedCustomer?.id ? 600 : 400,
                }}
              >
                {c.name}
              </button>
            ))}
            <div style={{ borderTop: '1px solid var(--border)' }}>
              <button
                onClick={() => { setOpen(false); setShowNewModal(true) }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '9px 16px', cursor: 'pointer', fontSize: 13,
                  background: 'transparent', border: 'none', color: 'var(--blue)',
                  fontWeight: 500,
                }}
              >
                + New Customer
              </button>
            </div>
          </div>
        )}
      </div>
      {showNewModal && (
        <NewCustomerModal
          onClose={() => setShowNewModal(false)}
          onCreated={async c => {
            await refreshCustomers()
            setSelectedCustomer(c)
            setShowNewModal(false)
          }}
        />
      )}
    </>
  )
}

function NavBar() {
  return (
    <nav className="nav">
      <span className="nav-brand">
        <span>Zones</span> · Cloud Health Portal
      </span>
      <NavLink to="/" end className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
        Dashboard
      </NavLink>
      <NavLink to="/upload" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
        Upload
      </NavLink>
      <NavLink to="/report" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
        Report Builder
      </NavLink>
      <NavLink to="/history" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
        History
      </NavLink>
      <NavLink to="/uploads" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
        Manage Uploads
      </NavLink>
      <NavLink to="/exceptions" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
        Exceptions
      </NavLink>
      <div style={{ marginLeft: 'auto' }}>
        <CustomerPill />
      </div>
    </nav>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <NavBar />
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/upload" element={<Upload />} />
        <Route path="/report" element={<ReportBuilder />} />
        <Route path="/history" element={<History />} />
        <Route path="/uploads" element={<Uploads />} />
        <Route path="/exceptions" element={<Exceptions />} />
      </Routes>
    </BrowserRouter>
  )
}
