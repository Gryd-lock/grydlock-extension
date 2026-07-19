import { addTrustedAddress } from '../utils/storageHelper';
import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import type { TierInfo } from '../lib/tiers';

interface TierWarningProps {
  tier: TierInfo;
  score: number;
  destination?: string;
  onCancel: () => void;
  onProceed: () => void;
  devControl?: ReactNode;
}

export default function TierWarning({
  tier,
  score,
  destination,
  onCancel,
  onProceed,
  devControl,
}: TierWarningProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  // Focus the Cancel button on mount for accessibility
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // Key handling for Escape and Tab navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCancel();
    } else if (e.key === 'Tab') {
      const container = popupRef.current;
      if (!container) return;
      const focusable = focusableWithin(container);
      if (focusable.length === 0) return;
      e.preventDefault();
      const current = document.activeElement as HTMLElement;
      let idx = focusable.indexOf(current);
      // If focus is outside the popup, start from before the first element
      if (idx === -1) idx = e.shiftKey ? 0 : -1;
      const step = e.shiftKey ? -1 : 1;
      const nextIdx = (idx + step + focusable.length) % focusable.length;
      focusable[nextIdx].focus();
    }
  };



  // Global Tab handler to bring focus back if it escapes (helps JSDOM environment)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        const active = document.activeElement as HTMLElement;
        if (popupRef.current && !popupRef.current.contains(active)) {
          e.preventDefault();
          cancelRef.current?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const describedByIds = [
    destination ? 'tier-warning-destination' : null,
    'tier-warning-score',
    'tier-warning-message',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={popupRef}
      className="popup"
      data-tier={tier.tier}
      role="dialog"
      aria-modal="true"
      aria-labelledby="tier-warning-title"
      aria-describedby={describedByIds}
      style={{
        '--tier-accent-light': tier.colour,
        '--tier-accent-dark': tier.darkColour,
      } as CSSProperties}
      onKeyDown={handleKeyDown}
    >
      <h1 id="tier-warning-title" aria-live="assertive">
        <span className="tier-icon" aria-hidden="true">{tier.icon}</span>{' '}
        {tier.label} risk
      </h1>
      {destination && (
        <p id="tier-warning-destination" className="destination">
          {destination}
        </p>
      )}
      <p id="tier-warning-score" className="score">
        Score: {score}
      </p>
      <p id="tier-warning-message" className="message">
        {tier.message}
      </p>
      <div className="actions">
        <button className="cancel" onClick={onCancel} ref={cancelRef}>
          Cancel
        </button>
        {destination && (tier.tier === 'low' || tier.tier === 'elevated') && (
          <button className="trust" onClick={() => addTrustedAddress(destination)}>
            Trust this destination
          </button>
        )}
        <button className="proceed" onClick={onProceed}>
          Proceed
        </button>
      </div>
      {devControl}
    </div>
  );
}

// Helper to find focusable elements inside a container
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true'
  );
}
