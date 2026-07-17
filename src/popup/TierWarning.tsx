import type { ReactNode } from 'react'
import type { TierInfo } from '../lib/tiers'

interface TierWarningProps {
  tier: TierInfo
  score: number
  destination?: string
  onCancel: () => void
  onProceed: () => void
  devControl?: ReactNode
}

export default function TierWarning({
  tier,
  score,
  destination,
  onCancel,
  onProceed,
  devControl,
}: TierWarningProps) {
  // We construct a list of IDs to wire up the describedby relationship,
  // omitting the destination if it's not present.
  const describedByIds = [
    destination ? 'tier-warning-destination' : null,
    'tier-warning-score',
    'tier-warning-message'
  ].filter(Boolean).join(' ')

  return (
    <div 
      className="popup" 
      style={{ borderTop: `4px solid ${tier.colour}` }}
      role="alertdialog"
      aria-labelledby="tier-warning-title"
      aria-describedby={describedByIds}
    >
      {/* Icon paired with label so tier is never conveyed by colour alone (WCAG 1.4.1) */}
      <h1 id="tier-warning-title" aria-live="assertive">
        <span className="tier-icon" aria-hidden="true">
          {tier.icon}
        </span>{' '}
        {tier.label} risk
      </h1>
      {destination && <p id="tier-warning-destination" className="destination">{destination}</p>}
      <p id="tier-warning-score" className="score">Score: {score}</p>
      <p id="tier-warning-message" className="message">{tier.message}</p>
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
