import { useEffect, useState } from 'react'
import { getScore } from '../adapter/oracleAdapter'
import { tierForScore } from '../lib/tiers'
import DevScoreSlider from './DevScoreSlider'
import './App.css'

const PLACEHOLDER_DESTINATION = 'GABCDEXAMPLE0000000000000000000000000000000000000000000'

export default function App() {
  const [score, setScore] = useState<number | null>(null)
  const [devOverride, setDevOverride] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    getScore(PLACEHOLDER_DESTINATION).then((result) => {
      if (!cancelled) setScore(result)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const displayScore = devOverride ?? score

  if (displayScore === null) {
    return <div className="popup">Checking destination…</div>
  }

  const tier = tierForScore(displayScore)

  return (
    <div className="popup" style={{ borderTop: `4px solid ${tier.colour}` }}>
      <h1>{tier.label} risk</h1>
      <p className="score">Score: {displayScore}</p>
      <p className="message">{tier.message}</p>
      <div className="actions">
        <button className="cancel" onClick={() => window.close()}>
          Cancel
        </button>
        <button className="proceed" onClick={() => window.close()}>
          Proceed
        </button>
      </div>
      {import.meta.env.DEV && <DevScoreSlider score={displayScore} onChange={setDevOverride} />}
    </div>
  )
}
