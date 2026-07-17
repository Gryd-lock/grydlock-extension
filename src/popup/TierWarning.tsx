import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import type { TierInfo } from '../lib/tiers'

interface TierWarningProps {
  tier: TierInfo
  score: number
  destination?: string
  expiresAt?: number
  onCancel: () => void
  onProceed: () => void
  devControl?: ReactNode
}

export default function TierWarning({
  tier,
  score,
  destination,
  expiresAt,
  onCancel,
  onProceed,
  devControl,
}: TierWarningProps) {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(() => {
    if (!expiresAt) return null
    return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
  })

  useEffect(() => {
    if (!expiresAt) return

    const updateTimer = () => {
      const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
      setSecondsLeft(remaining)
    }

    updateTimer()
    const interval = setInterval(updateTimer, 1000)
    return () => clearInterval(interval)
  }, [expiresAt])

  return (
    <div className="popup" style={{ borderTop: `4px solid ${tier.colour}` }}>
      {/* Icon paired with label so tier is never conveyed by colour alone (WCAG 1.4.1) */}
      <h1>
        <span className="tier-icon" aria-hidden="true">
          {tier.icon}
        </span>{' '}
        {tier.label} risk
      </h1>
      {destination && <p className="destination">{destination}</p>}
      <p className="score">Score: {score}</p>
      {secondsLeft !== null && <p className="expires-in">Expires in {secondsLeft}s</p>}
      <p className="message">{tier.message}</p>
      <div className="actions">
        <button className="cancel" onClick={onCancel}>
          Cancel
        </button>
        <button className="proceed" onClick={onProceed}>
          Proceed
        </button>
      </div>
      {devControl}
    </div>
  )
}
