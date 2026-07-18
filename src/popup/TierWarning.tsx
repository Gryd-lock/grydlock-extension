import type { CSSProperties, ReactNode } from 'react'
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
  return (
    <div
      className="popup"
      data-tier={tier.tier}
      style={
        {
          '--tier-accent-light': tier.colour,
          '--tier-accent-dark': tier.darkColour,
        } as CSSProperties
      }
    >
      {/* Icon paired with label so tier is never conveyed by colour alone (WCAG 1.4.1) */}
      <h1>
        <span className="tier-icon" aria-hidden="true">
          {tier.icon}
        </span>{' '}
        {tier.label} risk
      </h1>
      {destination && <p className="destination">{destination}</p>}
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
