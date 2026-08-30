import type { Outcome } from './protocol'

export interface AwaitOutcomeResponse {
  type: 'SIGN_OUTCOME'
  requestId: string
  outcome: Outcome
}

export interface AwaitOutcomeDeps {
  /** Resolves `undefined` on any failure (disconnected port, dead/restarting worker) rather than rejecting — a rejection would abort the retry loop instead of triggering a retry. */
  sendMessage: (requestId: string) => Promise<AwaitOutcomeResponse | undefined>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  backoffMs?: (attempt: number) => number
}

const DEFAULT_BACKOFF_MS = (attempt: number) => Math.min(250 * attempt, 2_000)

/**
 * The bridge's resume/status handshake loop. Every attempt is a fresh,
 * independent round trip — there is no callback held open across a worker
 * restart — so a background service worker that suspends or is killed and
 * restarted mid-review is transparently reconnected to on the next attempt:
 * the answer always comes from the worker's durable state, not from a
 * resolver that could not have survived suspension. Bounded by an absolute
 * deadline so a missing/unresponsive background can never hang this loop
 * past that point; it resolves 'cancel' once the deadline passes.
 */
export async function awaitOutcome(
  requestId: string,
  deadlineAt: number,
  deps: AwaitOutcomeDeps,
): Promise<Outcome> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const backoffMs = deps.backoffMs ?? DEFAULT_BACKOFF_MS

  let attempt = 0
  while (now() < deadlineAt) {
    const response = await deps.sendMessage(requestId)
    if (response?.type === 'SIGN_OUTCOME' && response.requestId === requestId) {
      return response.outcome
    }
    attempt += 1
    await sleep(backoffMs(attempt))
  }

  return 'cancel'
}
