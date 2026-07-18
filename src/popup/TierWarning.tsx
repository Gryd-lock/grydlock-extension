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

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true',
  )
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
      data-tier={tier.tier}
      style={
        {
          '--tier-accent-light': tier.colour,
          '--tier-accent-dark': tier.darkColour,
        } as CSSProperties
      }
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
        <button className="cancel" onClick={onCancel} ref={cancelRef}>
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
