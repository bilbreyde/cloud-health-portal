import { useEffect, useState } from 'react'

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
                     'July', 'August', 'September', 'October', 'November', 'December']

function storageKey(month: string) {
  return `partialMonthBannerDismissed:${month}`
}

export default function PartialMonthBanner({ month, completionRatio }: { month: string; completionRatio: number }) {
  const [dismissed, setDismissed] = useState(true)

  useEffect(() => {
    setDismissed(localStorage.getItem(storageKey(month)) === '1')
  }, [month])

  if (dismissed) return null

  const [y, m] = month.split('-').map(Number)
  const monthName = MONTH_NAMES[(m || 1) - 1]
  const daysInMonth = new Date(y, m, 0).getDate()
  const daysElapsed = Math.round(completionRatio * daysInMonth)
  const pct = Math.round(completionRatio * 100)

  function dismiss() {
    localStorage.setItem(storageKey(month), '1')
    setDismissed(true)
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
      padding: '10px 16px', background: '#EBF3FB', border: '1px solid #BEE0F7', borderRadius: 8,
      marginBottom: 16, fontSize: 13,
    }}>
      <span>
        <strong>{monthName}</strong> data is {pct}% complete ({daysElapsed} of {daysInMonth} days).{' '}
        MoM comparisons use projected full-month figures.
      </span>
      <button onClick={dismiss} className="btn btn-ghost" style={{ padding: '2px 10px', fontSize: 12, flexShrink: 0 }}>
        Dismiss
      </button>
    </div>
  )
}
