import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function storageKey(month: string) {
  return `marketplaceBannerDismissed:${month}`
}

function fmtMoney(n: number) {
  return '$' + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })
}

function fmtMonthLabel(m: string) {
  const [y, mo] = m.split('-').map(Number)
  return `${MONTH_ABBR[(mo || 1) - 1]} ${y}`
}

interface Props {
  month: string
  amount: number
}

function SingleBanner({ month, amount }: Props) {
  const [dismissed, setDismissed] = useState(true)

  useEffect(() => {
    setDismissed(localStorage.getItem(storageKey(month)) === '1')
  }, [month])

  if (dismissed) return null

  function dismiss() {
    localStorage.setItem(storageKey(month), '1')
    setDismissed(true)
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
      padding: '10px 16px', background: '#FFF4CE', border: '1px solid #F5DFA0', borderRadius: 8,
      marginBottom: 12, fontSize: 13,
    }}>
      <span>
        <strong>{fmtMonthLabel(month)}</strong> has an unidentified Marketplace purchase of{' '}
        <strong>{fmtMoney(amount)}</strong> — <Link to="/spend-insights">Add a note in Spend Insights</Link>
      </span>
      <button onClick={dismiss} className="btn btn-ghost" style={{ padding: '2px 10px', fontSize: 12, flexShrink: 0 }}>
        Dismiss
      </button>
    </div>
  )
}

export default function MarketplaceBanner({ purchases }: { purchases: Props[] }) {
  if (purchases.length === 0) return null
  return (
    <>
      {purchases.map(p => <SingleBanner key={p.month} month={p.month} amount={p.amount} />)}
    </>
  )
}
