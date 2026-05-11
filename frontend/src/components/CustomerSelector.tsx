import { useEffect, useState } from 'react'
import { fetchCustomers } from '../api'
import type { Customer } from '../types'

interface Props {
  value: string
  onChange: (id: string) => void
}

export default function CustomerSelector({ value, onChange }: Props) {
  const [customers, setCustomers] = useState<Customer[]>([])

  useEffect(() => {
    fetchCustomers()
      .then(setCustomers)
      .catch(() => setCustomers([]))
  }, [])

  return (
    <div className="field">
      <label>Customer</label>
      <select value={value} onChange={e => onChange(e.target.value)}>
        <option value="">— Select customer —</option>
        {customers.map(c => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
    </div>
  )
}
