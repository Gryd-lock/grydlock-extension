import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import type { TierInfo } from '../lib/tiers'
import type { AggregatedReview, OracleSourceKind, TargetEvidence } from '../review/model'

interface DestinationRow {
  destination: string
  asset?: string
  score: number
}

interface TierWarningProps {
  tier: TierInfo
  /** Synthetic score for previews/dev only. Real reviews show per-destination evidence instead. */
  score?: number
  destinations?: DestinationRow[]
  onCancel: () => void
  onProceed: () => void
  devControl?: ReactNode
  review?: AggregatedReview
}

const SOURCE_LABELS: Record<OracleSourceKind, string> = {
  off: 'scoring off',
  'testkit-fixtures': 'testkit fixtures',
  soroban: 'Soroban oracle',
}

function evidenceText(item: TargetEvidence, source: OracleSourceKind | undefined): string {
  const via = source ? SOURCE_LABELS[source] : 'oracle'
  switch (item.status) {
    case 'available':
      return `Score ${item.score} / 100 (${via})`
    case 'unscored':
      return `No score in ${via}`
    case 'unavailable':
      return `Assessment unavailable (${via} did not answer)`
    case 'not-configured':
      return 'Not scored — destination scoring is off in settings'
  }
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
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
  destinations = [],
  onCancel,
  onProceed,
  devControl,
  review,
}: TierWarningProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const highConfirmId = useId()
  const criticalConfirmId = useId()
  const [highConfirmed, setHighConfirmed] = useState(false)
  const [criticalConfirmation, setCriticalConfirmation] = useState('')
  const requiresHighConfirmation = tier.tier === 'high'
  const requiresCriticalConfirmation = tier.tier === 'critical'
  const criticalPhrase = tier.label.toUpperCase()
  const proceedEnabled =
    !requiresHighConfirmation && !requiresCriticalConfirmation
      ? true
      : requiresHighConfirmation
        ? highConfirmed
        : criticalConfirmation.trim().toUpperCase() === criticalPhrase

  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  useEffect(() => {
    function handleDocumentKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Tab' || !dialogRef.current) return

      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault()
        cancelRef.current?.focus()
      }
    }

    document.addEventListener('keydown', handleDocumentKeyDown)
    return () => document.removeEventListener('keydown', handleDocumentKeyDown)
  }, [])

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      onCancel()
      return
    }

    if (event.key !== 'Tab' || !dialogRef.current) return

    const focusable = focusableWithin(dialogRef.current)
    if (focusable.length === 0) return

    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement)
    const nextIndex = event.shiftKey
      ? currentIndex <= 0
        ? focusable.length - 1
        : currentIndex - 1
      : currentIndex === -1 || currentIndex === focusable.length - 1
        ? 0
        : currentIndex + 1

    event.preventDefault()
    focusable[nextIndex].focus()
  }

  return (
    <div
      ref={dialogRef}
      className="popup"
      data-tier={tier.tier}
      role="dialog"
      aria-modal="true"
      aria-labelledby="tier-warning-title"
      onKeyDown={handleKeyDown}
      style={
        {
          '--tier-accent-light': tier.colour,
          '--tier-accent-dark': tier.darkColour,
        } as CSSProperties
      }
    >
      <h1 id="tier-warning-title" aria-live="assertive">
        <span className="tier-icon" aria-hidden="true">
          {tier.icon}
        </span>{' '}
        {tier.label} risk
      </h1>
      {review && (
        <section className="review-summary" aria-label="Transaction review summary">
          <p><strong>Network:</strong> {review.review.networkPassphrase}</p>
          <p><strong>Envelope:</strong> {review.review.envelope.type} · {review.review.envelope.operationCount} operations</p>
          <p className="digest"><strong>Transaction digest:</strong> {review.review.xdrDigest}</p>
          {review.review.envelope.feeSource && <p><strong>Fee source:</strong> {review.review.envelope.feeSource}</p>}
          {review.review.memo && <p><strong>{review.review.memo.label}:</strong> {review.review.memo.value}</p>}
          {review.findings.length > 0 && (
            <div className="critical-findings" role="alert" aria-label="Transaction review findings">
              <h2>Important findings</h2>
              <ul>
                {review.findings.map((finding) => (
                  <li key={`${finding.code}:${finding.operationIndex ?? 'envelope'}`}><strong>{finding.title}:</strong> {finding.detail}</li>
                ))}
              </ul>
            </div>
          )}
          {review.evidence.length > 0 && (
            <>
              <h2>Destination assessment</h2>
              <ul className="evidence" aria-label="Destination assessment">
                {review.evidence.map((item) => (
                  <li key={`${item.target.type}:${item.target.value}`} data-status={item.status}>
                    <span className="destination">{item.target.value}</span>
                    {item.target.asset ? ` (${item.target.asset})` : ''} —{' '}
                    {evidenceText(item, review.oracleSource)}
                  </li>
                ))}
              </ul>
            </>
          )}
          <h2>Operations (in signing order)</h2>
          <ol className="operations">
            {review.review.operations.map((operation) => (
              <li key={operation.index}>
                <details>
                  <summary>#{operation.index + 1} {operation.summary} — {operation.coverage}</summary>
                  <p><strong>Source:</strong> {operation.source}</p>
                  {operation.facts.length > 0 && <ul>{operation.facts.map((entry) => <li key={`${entry.label}:${entry.value}`}><strong>{entry.label}:</strong> {entry.value}</li>)}</ul>}
                  {operation.targets.length > 0 && <p><strong>Targets:</strong> {operation.targets.map((target) => `${target.type}: ${target.value}`).join(', ')}</p>}
                  {operation.findings.length > 0 && <ul>{operation.findings.map((finding) => <li key={`${finding.code}:${finding.title}`}><strong>{finding.title}:</strong> {finding.detail}</li>)}</ul>}
                </details>
              </li>
            ))}
          </ol>
          {review.review.operations.some((operation) => operation.coverage !== 'understood') && <p className="incomplete" role="status">This review includes partial or opaque operations. They are not assessed as safe.</p>}
        </section>
      )}
      {destinations.length === 1 && <p className="destination">{destinations[0].destination}</p>}
      {destinations.length > 1 && (
        <ul className="destinations" aria-label="Transaction destinations">
          {destinations.map((item) => (
            <li key={`${item.destination}:${item.asset ?? ''}`}>
              {item.destination}
              {item.asset ? ` (${item.asset})` : ''}
              {' — '}
              Score: {item.score}
            </li>
          ))}
        </ul>
      )}
      {score !== undefined && <p className="score">Score: {score}</p>}
      <p className="message">{tier.message}</p>
      {devControl}
      {requiresHighConfirmation && (
        <label className="confirmation-panel confirmation-check" htmlFor={highConfirmId}>
          <input
            id={highConfirmId}
            type="checkbox"
            checked={highConfirmed}
            onChange={(event) => setHighConfirmed(event.target.checked)}
          />
          <span>I understand this destination shows strong risk signals.</span>
        </label>
      )}
      {requiresCriticalConfirmation && (
        <div className="confirmation-panel">
          <label htmlFor={criticalConfirmId}>
            Type <strong>{criticalPhrase}</strong> to enable Proceed.
          </label>
          <input
            id={criticalConfirmId}
            className="confirmation-input"
            type="text"
            value={criticalConfirmation}
            onChange={(event) => setCriticalConfirmation(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      )}
      <div className="actions">
        <button className="cancel" onClick={onCancel} ref={cancelRef}>
          Cancel
        </button>
        <button className="proceed" onClick={onProceed} disabled={!proceedEnabled}>
          Proceed
        </button>
      </div>
    </div>
  )
}
