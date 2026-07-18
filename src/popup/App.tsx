import { useEffect, useState } from 'react'
import { getScore } from '../adapter/oracleAdapter'
import { tierForScore, UNSCORED_TIER_INFO } from '../lib/tiers'
import DevScoreSlider from './DevScoreSlider'
import TierWarning from './TierWarning'
import type { RuntimeDecisionMadeMessage } from '../intercept/protocol'
import './App.css'

const PLACEHOLDER_DESTINATION = 'GABCDEXAMPLE0000000000000000000000000000000000000000000'

type LoadState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; score: number }

export default function App() {
  const params = new URLSearchParams(window.location.search)
  if (params.get('mode') === 'intercept') {
    return <InterceptView params={params} />
  }
  return <DevPreview />
}

function InterceptView({ params }: { params: URLSearchParams }) {
  const requestId = params.get('requestId') ?? ''
  const destination = params.get('destination') ?? ''
  const asset = params.get('asset') ?? undefined
  const scoreParam = params.get('score')
  // A missing score param means the background worker could not reach the
  // oracle. Treat this as a distinct "unscored" state — never conflate it
  // with a low-risk scored result or the silent "no destination" allow path.
  const isUnscored = scoreParam === null
  const score = isUnscored ? 0 : Number(scoreParam)
  const tier = isUnscored ? UNSCORED_TIER_INFO : tierForScore(score)

  function respond(decision: 'proceed' | 'cancel') {
    const message: RuntimeDecisionMadeMessage = { type: 'DECISION_MADE', requestId, decision }
    chrome.runtime.sendMessage(message)
    window.close()
  }

  return (
    <TierWarning
      tier={tier}
      score={isUnscored ? null : score}
      destination={asset ? `${destination} (${asset})` : destination}
      onCancel={() => respond('cancel')}
      onProceed={() => respond('proceed')}
    />
  )
}

function DevPreview() {
  const [attempt, setAttempt] = useState(0)
  return <ScoreView key={attempt} onRetry={() => setAttempt((n) => n + 1)} />
}

function ScoreView({ onRetry }: { onRetry: () => void }) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [devOverride, setDevOverride] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    getScore(PLACEHOLDER_DESTINATION)
      .then((score) => {
        if (!cancelled) setState({ status: 'ready', score })
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (state.status === 'loading') {
    return <div className="popup">Checking destination…</div>
  }

  if (state.status === 'error') {
    return (
      <div className="popup">
        <p className="message">Could not reach the risk oracle.</p>
        <button className="proceed" onClick={onRetry}>
          Retry
        </button>
      </div>
    )
  }

  const displayScore = devOverride ?? state.score
  const tier = tierForScore(displayScore)

  return (
    <TierWarning
      tier={tier}
      score={displayScore}
      onCancel={() => window.close()}
      onProceed={() => window.close()}
      devControl={
        import.meta.env.DEV && <DevScoreSlider score={displayScore} onChange={setDevOverride} />
      }
    />
  )
}
