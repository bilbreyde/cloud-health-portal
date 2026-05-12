import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { fetchCustomers } from '../api'
import type { Customer } from '../types'

interface CustomerContextValue {
  customers: Customer[]
  selectedCustomer: Customer | null
  setSelectedCustomer: (c: Customer | null) => void
  refreshCustomers: () => Promise<void>
  customersLoading: boolean
}

const CustomerContext = createContext<CustomerContextValue>({
  customers: [],
  selectedCustomer: null,
  setSelectedCustomer: () => {},
  refreshCustomers: async () => {},
  customersLoading: true,
})

export function useCustomer() {
  return useContext(CustomerContext)
}

export function CustomerProvider({ children }: { children: ReactNode }) {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [selectedCustomer, setSelectedCustomerState] = useState<Customer | null>(null)
  const [customersLoading, setCustomersLoading] = useState(true)

  const refreshCustomers = useCallback(async () => {
    setCustomersLoading(true)
    try {
      const list = await fetchCustomers()
      setCustomers(list)
      setSelectedCustomerState(prev => {
        if (prev) {
          const stillExists = list.find(c => c.id === prev.id)
          if (stillExists) return stillExists
        }
        const stored = localStorage.getItem('selectedCustomerId')
        if (stored) {
          const found = list.find(c => c.id === stored)
          if (found) return found
        }
        return list[0] ?? null
      })
    } finally {
      setCustomersLoading(false)
    }
  }, [])

  useEffect(() => { refreshCustomers() }, [refreshCustomers])

  function setSelectedCustomer(c: Customer | null) {
    if (c) localStorage.setItem('selectedCustomerId', c.id)
    else localStorage.removeItem('selectedCustomerId')
    setSelectedCustomerState(c)
  }

  return (
    <CustomerContext.Provider value={{ customers, selectedCustomer, setSelectedCustomer, refreshCustomers, customersLoading }}>
      {children}
    </CustomerContext.Provider>
  )
}
