import type { ReactNode } from 'react'
import type { TierInfo } from '../lib/tiers'

interface TierWarningProps {
  tier: TierInfo
  score: number
  destination?: string
  memo?: { type: string; value: string }
  onCancel: () => void
  onProceed: () => void
  devControl?: ReactNode
}

export default function TierWarning({
  tier,
  score,
  destination,
  memo,
  onCancel,
  onProceed,
  devControl,
}: TierWarningProps) {
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
      {memo && (
        <p className="memo">
          <strong>Memo ({memo.type}):</strong> {memo.value}
        </p>
      )}
      <p className="score">Score: {score}</p>
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
