import {
  PAGE_DEADLINE_MS,
  SIGN_PROTOCOL_VERSION,
  WINDOW_REQUEST_TYPE,
  WINDOW_RESPONSE_TYPE,
  type Outcome,
} from './protocol'
import type { SigningAdapter } from '../signing/pendingRequestState'

/**
 * Shared by mainWorldEntry.ts (Freighter) and albedoMainWorldEntry.ts
 * (Albedo) — previously duplicated verbatim in both files. `localId` is a
 * same-window postMessage correlation token only; it never crosses the
 * bridge into the background worker and is never treated as an
 * authoritative capability anywhere downstream.
 *
 * A page-side absolute deadline is required because the bridge content
 * script can be stale or missing entirely (e.g. after an extension update
 * replaces bridge.js but this MAIN-world script, injected into an
 * already-open tab, keeps running the old build) — without it, a request
 * whose response never arrives would hang the dApp's promise forever.
 */
export function requestOutcome(
  xdr: string,
  networkPassphrase: string | undefined,
  adapter: SigningAdapter,
): Promise<Outcome> {
  const localId = crypto.randomUUID()

  return new Promise((resolve) => {
    let settled = false

    function settle(outcome: Outcome) {
      if (settled) return
      settled = true
      window.removeEventListener('message', onMessage)
      window.clearTimeout(deadline)
      resolve(outcome)
    }

    function onMessage(event: MessageEvent) {
      if (event.source !== window) return
      const data = event.data as { type?: string; localId?: string; outcome?: string } | undefined
      if (data?.type !== WINDOW_RESPONSE_TYPE || data.localId !== localId) return
      const outcome = data.outcome
      settle(outcome === 'proceed' || outcome === 'allow' ? outcome : 'cancel')
    }

    window.addEventListener('message', onMessage)
    const deadline = window.setTimeout(() => settle('cancel'), PAGE_DEADLINE_MS)
    window.postMessage(
      {
        type: WINDOW_REQUEST_TYPE,
        protocolVersion: SIGN_PROTOCOL_VERSION,
        localId,
        xdr,
        networkPassphrase,
        adapter,
      },
      '*',
    )
  })
}
