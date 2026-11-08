import { useEffect, useState } from 'react'
import { tierForScore, tierInfoFor } from '../lib/tiers'
import DevScoreSlider from './DevScoreSlider'
import TierWarning from './TierWarning'
import TrustedAddressesManager from './TrustedAddressesManager'
import ProtectionStatusPanel from './ProtectionStatus'
import { SIGN_PROTOCOL_VERSION, type RuntimeDecisionMadeMessage } from '../intercept/protocol'
import type { AggregatedReview } from '../review/model'
import { displayTier } from '../review/policy'
import './App.css'

const PLACEHOLDER_DESTINATION = 'GABCDEXAMPLE0000000000000000000000000000000000000000000'
const PREVIEW_DESTINATION = 'GDRWZV7XVISUALREGRESSIONDESTINATION0000000000000000000'

type PreviewState =
  | 'loading'
  | 'error'
  | 'low'
  | 'elevated'
  | 'high'
  | 'critical'
  | 'dev-slider'
  | 'review'

const REVIEW_PREVIEW: AggregatedReview = {
  severity: 'high',
  evidence: [],
  findings: [
    {
      code: 'authority-change',
      severity: 'high',
      title: 'Account authority change',
      detail: 'Signer, threshold, flag, or account-option changes can alter future authorization.',
      operationIndex: 0,
    },
    {
      code: 'incomplete-coverage',
      severity: 'warning',
      title: 'Some transaction effects are not fully understood',
      detail: 'Review every partial or opaque operation before proceeding.',
      operationIndex: 1,
    },
  ],
  review: {
    schemaVersion: 1,
    policyVersion: 1,
    networkPassphrase: 'Test SDF Network ; September 2015',
    xdrDigest: 'a'.repeat(64),
    envelope: { type: 'fee-bump', source: PREVIEW_DESTINATION, feeSource: PREVIEW_DESTINATION, operationCount: 2 },
    operations: [
      {
        index: 0,
        type: 'setOptions',
        source: PREVIEW_DESTINATION,
        coverage: 'understood',
        summary: 'Change account options',
        facts: [{ label: 'Signer', value: PREVIEW_DESTINATION, provenance: 'xdr' }],
        targets: [],
        findings: [],
      },
      {
        index: 1,
        type: 'invokeHostFunction',
        source: PREVIEW_DESTINATION,
        coverage: 'opaque',
        summary: 'Soroban invocation',
        facts: [],
        targets: [],
        findings: [],
      },
    ],
    findings: [],
  },
}

export default function App() {
  const params = new URLSearchParams(window.location.search)
  const preview = params.get('preview') as PreviewState | null
  if (preview) {
    return <PreviewView preview={preview} />
  }
  if (params.get('mode') === 'intercept') {
    return <InterceptView params={params} />
  }
  if (import.meta.env.DEV && params.get('dev') === 'score') {
    return <DevPreview initialScore={Number(params.get('score') ?? 50)} />
  }
  return <ProtectionStatusPanel />
}

function PreviewView({ preview }: { preview: PreviewState }) {
  if (preview === 'loading') {
    return <div className="popup">Checking destination…</div>
  }

  if (preview === 'error') {
    return (
      <div className="popup">
        <p className="message">Could not reach the risk oracle.</p>
        <button className="proceed" type="button">
          Retry
        </button>
      </div>
    )
  }

  if (preview === 'review') {
    return (
      <TierWarning
        tier={tierForScore(60)}
        score={60}
        review={REVIEW_PREVIEW}
        onCancel={() => {}}
        onProceed={() => {}}
      />
    )
  }

  const previewScores = {
    low: 10,
    elevated: 35,
    high: 60,
    critical: 85,
  } as const
  const score = preview === 'dev-slider' ? 35 : previewScores[preview]
  const tier = tierForScore(score)

  return (
    <TierWarning
      tier={tier}
      score={score}
      destinations={[{ destination: PREVIEW_DESTINATION, score }]}
      onCancel={() => {}}
      onProceed={() => {}}
      devControl={
        preview === 'dev-slider' ? <DevScoreSlider score={score} onChange={() => {}} /> : undefined
      }
    />
  )
}

type ReviewLoadState = 'loading' | 'unavailable' | { review: AggregatedReview }

/**
 * Fails closed when review data cannot be loaded (e.g. a worker restart
 * mid-review lost the in-memory content, or this popup's window doesn't
 * match the request's bound review window) instead of falling back to a
 * URL-supplied score. That fallback used to default to a reassuring 'low'
 * tier via a always-empty destinations/score URL param, silently
 * misrepresenting an indeterminate review as low risk — the one thing this
 * warning exists to never do.
 */
function InterceptView({ params }: { params: URLSearchParams }) {
  const requestId = params.get('requestId') ?? ''
  const canFetchReview = Boolean(requestId && chrome?.runtime?.sendMessage)
  const [reviewState, setReviewState] = useState<ReviewLoadState>(
    canFetchReview ? 'loading' : 'unavailable',
  )

  useEffect(() => {
    if (!canFetchReview) return
    let cancelled = false
    chrome.runtime.sendMessage(
      { type: 'GET_REVIEW', protocolVersion: SIGN_PROTOCOL_VERSION, requestId },
      (response: { review?: AggregatedReview } | undefined) => {
        if (cancelled) return
        setReviewState(response?.review ? { review: response.review } : 'unavailable')
      },
    )
    return () => {
      cancelled = true
    }
  }, [canFetchReview, requestId])

  function respond(decision: 'proceed' | 'cancel') {
    const message: RuntimeDecisionMadeMessage = {
      type: 'DECISION_MADE',
      protocolVersion: SIGN_PROTOCOL_VERSION,
      requestId,
      decision,
    }
    chrome.runtime.sendMessage(message)
    window.close()
  }

  if (reviewState === 'loading') {
    return <div className="popup">Checking destination…</div>
  }

  if (reviewState === 'unavailable') {
    return (
      <div className="popup">
        <p className="message">
          This request could not be loaded for review. For your safety, reject it and retry from
          the dApp.
        </p>
        <button className="cancel" type="button" onClick={() => respond('cancel')}>
          Reject
        </button>
      </div>
    )
  }

  const { review } = reviewState

  return (
    <TierWarning
      tier={tierInfoFor(displayTier(review))}
      review={review}
      onCancel={() => respond('cancel')}
      onProceed={() => respond('proceed')}
    />
  )
}

/**
 * Development-only harness (`?dev=score&score=N`) for exercising the tier
 * UI with the slider. It never consults an oracle; scores here are
 * synthetic and the route is compiled out of production builds.
 */
function DevPreview({ initialScore }: { initialScore: number }) {
  const [score, setScore] = useState(Number.isFinite(initialScore) ? initialScore : 50)
  const [showManager, setShowManager] = useState(false)

  return (
    <>
      <TierWarning
        tier={tierForScore(score)}
        score={score}
        destinations={[{ destination: PLACEHOLDER_DESTINATION, score }]}
        onCancel={() => window.close()}
        onProceed={() => window.close()}
        devControl={<DevScoreSlider score={score} onChange={setScore} />}
      />
      <button
        className="manage-trusted"
        onClick={() => setShowManager(true)}
        style={manageBtnStyle}
      >
        Manage Trusted Addresses
      </button>
      {showManager && <TrustedAddressesManager onClose={() => setShowManager(false)} />}
    </>
  )
}

const manageBtnStyle = {
  marginTop: '1rem',
  padding: '0.5rem 1rem',
  background: '#1976d2',
  color: '#fff',
  border: 'none',
  borderRadius: '4px',
  cursor: 'pointer',
} as const
