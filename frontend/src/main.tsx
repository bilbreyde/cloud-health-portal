import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import App from './App'
import { CustomerProvider } from './context/CustomerContext'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CustomerProvider>
      <App />
    </CustomerProvider>
  </React.StrictMode>
)
