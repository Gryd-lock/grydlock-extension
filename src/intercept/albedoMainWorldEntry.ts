/**
 * albedoMainWorldEntry.ts
 *
 * Intercepts Albedo signing requests in the MAIN world by monkey-patching
 * window.open. The @albedo-link/intent library always calls:
 *
 *   window.open(
 *     'https://albedo.link/confirm',
 *     'auth.albedo.link',
 *     'height=600,width=480,...'
 *   )
 *
 * and then postMessages the intent payload ({ intent, xdr, network, __reqid,
 * __albedo_intent_version, ... }) to the returned popup window reference.
 *
 * Interception strategy
 * ─────────────────────
 * 1. Patch window.open to detect the 'auth.albedo.link' window name.
 * 2. For non-tx intents (public_key, sign_message, etc.) and for tx intents
 *    when the popup has already opened, return a real popup so normal signing
 *    works — Gryd Lock only needs to score before the user sees the Albedo
 *    dialog, not replace it.
 * 3. When we intercept a tx (or pay) intent:
 *    a. Capture the XDR from the first postMessage to the popup.
 *    b. Route the XDR through the existing GRYDLOCK_REQUEST_OUTCOME /
 *       GRYDLOCK_OUTCOME_RESPONSE protocol (same bridge as Freighter).
 *    c. On 'cancel': close the real popup (if already open), post a synthetic
 *       albedoIntentResult error back to the dApp so its Promise rejects with
 *       the standard "rejected by user" error shape.
 *    d. On 'allow'/'proceed': let the real popup continue unmolested.
 *
 * Why window.open patching works here
 * ─────────────────────────────────────
 * The @albedo-link/intent library calls window.open synchronously as part of
 * the user-gesture handler, then immediately listens for messages from the
 * returned window. By returning a Proxy around the real window, we can
 * intercept the first postMessage call to capture the XDR before Albedo's
 * own popup receives it.
 *
 * Limitations
 * ───────────
 * • Implicit-flow intents bypass the popup entirely (they reuse an iframe
 *   session). We cannot intercept those without a more invasive hook.
 *   Gryd Lock currently only intercepts the interactive (popup) flow.
 * • Albedo's browser extension variant handles SEP-0007 links via a page
 *   redirect rather than a popup, which is a separate surface not covered here.
 * • Registration-order caveat: this script runs at document_start, before any
 *   dApp code, so the patch is in place before albedo-intent is imported.
 */

import { WINDOW_REQUEST_TYPE, WINDOW_RESPONSE_TYPE, type Outcome } from './protocol'

const ALBEDO_CONFIRM_ORIGIN = 'https://albedo.link'
const ALBEDO_WINDOW_NAME = 'auth.albedo.link'

/**
 * Intents that carry an XDR field and therefore go through the risk pipeline.
 * 'pay' is included because the albedo-intent library builds a transaction for
 * it and the destination address is available directly in the intent params.
 */
const TX_INTENTS = new Set(['tx', 'pay'])

/** Forward a sign-outcome request to the bridge via the shared protocol. */
function requestOutcome(xdr: string, networkPassphrase?: string): Promise<Outcome> {
  const localId = crypto.randomUUID()

  return new Promise((resolve) => {
    function onMessage(event: MessageEvent) {
      if (event.source !== window) return
      const data = event.data as
        | { type?: string; localId?: string; outcome?: string }
        | undefined
      if (data?.type !== WINDOW_RESPONSE_TYPE || data.localId !== localId) return
      window.removeEventListener('message', onMessage)
      const outcome = data.outcome
      resolve(outcome === 'proceed' || outcome === 'allow' ? outcome : 'cancel')
    }
    window.addEventListener('message', onMessage)
    window.postMessage(
      { type: WINDOW_REQUEST_TYPE, localId, xdr, networkPassphrase },
      '*',
    )
  })
}

/**
 * Build a synthetic albedoIntentResult rejection that looks identical to the
 * "action rejected by user" error that Albedo normally posts back.
 * reqid must match the __reqid the library attached to its outgoing message.
 */
function buildRejectionMessage(reqid: string): unknown {
  return {
    albedoIntentResult: {
      __reqid: reqid,
      error: {
        code: -4,
        message:
          'Action request was rejected by the user.',
        ext: 'Rejected by Gryd Lock: user cancelled after reviewing the risk warning.',
      },
    },
  }
}

// ─── window.open patch ───────────────────────────────────────────────────────

const _originalOpen = window.open.bind(window)

window.open = function grydlockOpen(
  url?: string | URL,
  target?: string,
  features?: string,
): WindowProxy | null {
  const urlStr = url instanceof URL ? url.href : url ?? ''

  // Only intercept calls that are opening the Albedo confirmation popup.
  if (
    target !== ALBEDO_WINDOW_NAME ||
    !urlStr.startsWith(ALBEDO_CONFIRM_ORIGIN)
  ) {
    return _originalOpen(url, target, features)
  }

  // Open the real Albedo popup so the user sees the normal Albedo UI if we
  // allow the transaction. We intercept the first postMessage to it.
  const realPopup = _originalOpen(url, target, features)
  if (!realPopup) {
    // Popup was blocked — fall through gracefully.
    return realPopup
  }

  /**
   * Wrap realPopup in a Proxy so we can observe the first postMessage call
   * from albedo-intent without breaking the normal popup communication.
   */
  let intercepted = false

  const proxy = new Proxy(realPopup, {
    get(target, prop) {
      if (prop === 'postMessage' && !intercepted) {
        return function albedoInterceptedPostMessage(
          message: unknown,
          targetOrigin: string,
          ...rest: unknown[]
        ) {
          const msg = message as Record<string, unknown> | null | undefined

          // Only intercept tx/pay intents.
          if (
            msg &&
            typeof msg === 'object' &&
            typeof msg.intent === 'string' &&
            TX_INTENTS.has(msg.intent)
          ) {
            intercepted = true

            const xdr = typeof msg.xdr === 'string' ? msg.xdr : undefined
            const network = typeof msg.network === 'string' ? msg.network : undefined
            const reqid = typeof msg.__reqid === 'string' ? msg.__reqid : ''

            if (!xdr) {
              // No XDR available (e.g. a pay intent where albedo builds the tx
              // itself) — allow through without scoring.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              return (target.postMessage as any)(message, targetOrigin, ...rest)
            }

            // Don't block the thread — run scoring async.
            requestOutcome(xdr, network).then((outcome) => {
              if (outcome === 'cancel') {
                // Close the real popup and synthesize a rejection.
                try { realPopup.close() } catch { /* cross-origin close is best-effort */ }
                window.postMessage(buildRejectionMessage(reqid), window.location.origin)
              } else {
                // Allow: forward the original message to the real popup.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ;(target.postMessage as any)(message, targetOrigin, ...rest)
              }
            })

            // Return undefined — we will deliver the message asynchronously.
            return undefined
          }

          // Not a tx intent — forward verbatim.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (target.postMessage as any)(message, targetOrigin, ...rest)
        }
      }

      // All other property accesses pass through to the real popup.
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  return proxy as WindowProxy
}
