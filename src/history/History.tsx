import { useEffect, useState } from 'react'
import { HISTORY_LIMIT, clearHistory, readHistory, type HistoryEntry } from '../lib/history'
import { tierForScore } from '../lib/tiers'
import './History.css'

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; entries: HistoryEntry[] }

export default function History() {
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    readHistory()
      .then((entries) => {
        if (!cancelled) setState({ status: 'ready', entries })
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function onClear() {
    await clearHistory()
    setState({ status: 'ready', entries: [] })
  }

  return (
    <div className="history">
      <h1>Decision history</h1>
      <p className="privacy-note">
        Stored only on this device (last {HISTORY_LIMIT} decisions). Nothing is ever transmitted.
      </p>
      {state.status === 'loading' && <p>Loading…</p>}
      {state.status === 'error' && <p>Could not read history.</p>}
      {state.status === 'ready' &&
        (state.entries.length === 0 ? (
          <p className="empty">No decisions recorded yet.</p>
        ) : (
          <>
            <button className="clear" onClick={onClear}>
              Clear history
            </button>
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Destination</th>
                  <th>Asset</th>
                  <th>Score</th>
                  <th>Tier</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {state.entries.map((entry, i) => {
                  const tier = tierForScore(entry.score)
                  return (
                    <tr key={`${entry.timestamp}-${i}`}>
                      <td>{new Date(entry.timestamp).toLocaleString()}</td>
                      <td className="destination">{entry.destination}</td>
                      <td>{entry.asset ?? '—'}</td>
                      <td>{entry.score}</td>
                      <td style={{ color: tier.colour }}>
                        <span aria-hidden="true">{tier.icon}</span> {tier.label}
                      </td>
                      <td>{entry.decision === 'proceed' ? 'Proceeded' : 'Cancelled'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </>
        ))}
    </div>
  )
}
