import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
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
  const popupRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  // Cancel is the default action for every tier: the safe choice must be one keypress away,
  // and never require hunting for focus on a High/Critical warning.
  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  // Read onCancel through a ref so the listener stays registered across re-renders even
  // though callers pass a fresh inline callback each time.
  const cancelHandler = useRef(onCancel)
  useEffect(() => {
    cancelHandler.current = onCancel
  }, [onCancel])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancelHandler.current()
        return
      }

      if (event.key !== 'Tab') return

      const popup = popupRef.current
      if (!popup) return
      const focusable = focusableWithin(popup)
      if (focusable.length === 0) return

      // Drive Tab ourselves rather than trusting the boundary elements to still be the ones
      // the browser lands on — this keeps the cycle closed even if focus has slipped out of
      // the popup (e.g. onto <body> after a click on non-focusable text).
      event.preventDefault()
      const active = document.activeElement as HTMLElement | null
      const current = active ? focusable.indexOf(active) : -1
      const step = event.shiftKey ? -1 : 1
      const next =
        current === -1
          ? focusable[event.shiftKey ? focusable.length - 1 : 0]
          : focusable[(current + step + focusable.length) % focusable.length]
      next.focus()
    }

    // Listen at the document: the popup is the whole extension window, so nothing outside it
    // is a legitimate focus target while a decision is pending.
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  // We construct a list of IDs to wire up the describedby relationship,
  // omitting the destination if it's not present.
  const describedByIds = [
    destination ? 'tier-warning-destination' : null,
    'tier-warning-score',
    'tier-warning-message',
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
      ref={popupRef}
      role="dialog"
      aria-modal="true"
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
