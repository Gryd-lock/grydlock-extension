import { WINDOW_REQUEST_TYPE, WINDOW_RESPONSE_TYPE, type Outcome } from './protocol'

/**
 * Real Freighter (`@stellar/freighter-api`) does not expose a callable
 * `window.freighterApi.signTransaction` — dApps that import the package post
 * a message shaped like this directly to `window`, and Freighter's own
 * content script listens for it and posts back a matching response. There is
 * no other hook point: interception has to happen at this postMessage layer.
 */
const FREIGHTER_REQUEST_SOURCE = 'FREIGHTER_EXTERNAL_MSG_REQUEST'
const FREIGHTER_RESPONSE_SOURCE = 'FREIGHTER_EXTERNAL_MSG_RESPONSE'
const SUBMIT_TRANSACTION_TYPE = 'SUBMIT_TRANSACTION'

interface FreighterSubmitTransactionRequest {
  source: typeof FREIGHTER_REQUEST_SOURCE
  messageId: number
  type: typeof SUBMIT_TRANSACTION_TYPE
  transactionXdr: string
  network?: string
  networkPassphrase?: string
  accountToSign?: string
  __grydlockReviewed?: boolean
}

function requestOutcome(xdr: string, networkPassphrase?: string): Promise<Outcome> {
  const requestId = crypto.randomUUID()

  return new Promise((resolve) => {
    function onMessage(event: MessageEvent) {
      if (event.source !== window) return
      const data = event.data as { type?: string; requestId?: string; outcome?: string } | undefined
      if (data?.type !== WINDOW_RESPONSE_TYPE || data.requestId !== requestId) return
      window.removeEventListener('message', onMessage)
      const outcome = data.outcome
      resolve(outcome === 'proceed' || outcome === 'allow' ? outcome : 'cancel')
    }
    window.addEventListener('message', onMessage)
    window.postMessage({ type: WINDOW_REQUEST_TYPE, requestId, xdr, networkPassphrase }, '*')
  })
}

/**
 * Grabs an outgoing SUBMIT_TRANSACTION request before Freighter's own
 * content-script listener sees it (registration-order dependent — this
 * script runs at document_start, but Chrome does not guarantee injection
 * order relative to another extension's content script). On 'cancel',
 * Freighter never sees the request at all; a decline response is synthesized
 * directly. On 'allow'/'proceed', the original request is re-posted verbatim
 * (tagged so we don't re-intercept our own re-dispatch) for Freighter to
 * handle exactly as it would have without us.
 */
window.addEventListener(
  'message',
  (event) => {
    if (event.source !== window) return
    const data = event.data as Partial<FreighterSubmitTransactionRequest> | undefined
    if (
      data?.source !== FREIGHTER_REQUEST_SOURCE ||
      data.type !== SUBMIT_TRANSACTION_TYPE ||
      data.__grydlockReviewed ||
      typeof data.transactionXdr !== 'string' ||
      typeof data.messageId !== 'number'
    ) {
      return
    }

    event.stopImmediatePropagation()
    const request = data as FreighterSubmitTransactionRequest
    const networkPassphrase = request.networkPassphrase ?? request.network

    requestOutcome(request.transactionXdr, networkPassphrase).then((outcome) => {
      if (outcome === 'cancel') {
        window.postMessage(
          {
            source: FREIGHTER_RESPONSE_SOURCE,
            messagedId: request.messageId,
            signedTransaction: '',
            signerAddress: '',
            apiError: {
              code: -4,
              message: 'Rejected by Gryd Lock: user cancelled after reviewing the risk warning.',
            },
          },
          window.location.origin,
        )
        return
      }

      window.postMessage({ ...request, __grydlockReviewed: true }, window.location.origin)
    })
  },
  true,
)
