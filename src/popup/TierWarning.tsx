import type { ReactNode } from 'react'
import type { TierInfo } from '../lib/tiers'

interface DestinationRow {
  destination: string
  asset?: string
  score: number
}

interface TierWarningProps {
  tier: TierInfo
  score: number
  destinations?: DestinationRow[]
  onCancel: () => void
  onProceed: () => void
  devControl?: ReactNode
}

export default function TierWarning({
  tier,
  score,
  destinations,
  onCancel,
  onProceed,
  devControl,
}: TierWarningProps) {
  const primary = destinations?.[0]

  return (
    <div className="popup" style={{ borderTop: `4px solid ${tier.colour}` }}>
      {/* Icon paired with label so tier is never conveyed by colour alone (WCAG 1.4.1) */}
      <h1>
        <span className="tier-icon" aria-hidden="true">
          {tier.icon}
        </span>{' '}
        {tier.label} risk
      </h1>
      {primary && (
        <p className="destination">
          {primary.asset ? `${primary.destination} (${primary.asset})` : primary.destination}
        </p>
      )}
      <p className="score">Worst score: {score}</p>
      {destinations && destinations.length > 1 && (
        <ul className="destination-list">
          {destinations.map((item) => (
            <li key={item.destination}>
              <span className="destination">{item.asset ? `${item.destination} (${item.asset})` : item.destination}</span>
              <span className="score">Score: {item.score}</span>
            </li>
          ))}
        </ul>
      )}
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
