import {
  BRIDGE_FALLBACK_DEADLINE_MS,
  SIGN_PROTOCOL_VERSION,
  WINDOW_PROTECTION_ACK_TYPE,
  WINDOW_PROTECTION_ADAPTER_STATUS_TYPE,
  WINDOW_PROTECTION_PROBE_TYPE,
  WINDOW_PROTECTION_RESPONSE_TYPE,
  WINDOW_REQUEST_TYPE,
  WINDOW_RESPONSE_TYPE,
  type RuntimeProtectionAdapterStatusMessage,
  type RuntimeProtectionBridgeOnlineMessage,
  type RuntimeProtectionHandshakeAckMessage,
  type RuntimeProtectionHandshakeMessage,
  type RuntimeSignAckMessage,
  type RuntimeSignRejectedMessage,
  type RuntimeSignRequestMessage,
} from './protocol'
import { PROTECTION_PROTOCOL_VERSION } from '../protection/protectionState'
import { awaitOutcome, type AwaitOutcomeResponse } from './awaitOutcome'
import type { SigningAdapter } from '../signing/pendingRequestState'

const MAX_NONCE_LENGTH = 128

function isSigningAdapter(value: unknown): value is SigningAdapter {
  return value === 'freighter' || value === 'albedo-popup'
}

/** Resolves `undefined` on any failure (disconnected port, dead/restarting worker) instead of rejecting, so a caller can retry rather than abort. */
function sendRuntimeMessage<TResponse>(message: unknown): Promise<TResponse | undefined> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response: TResponse | undefined) => {
      if (chrome.runtime.lastError) {
        resolve(undefined)
        return
      }
      resolve(response)
    })
  })
}

function isProtectionAdapter(value: unknown): value is 'freighter' | 'albedo-popup' {
  return value === 'freighter' || value === 'albedo-popup'
}

function isNonce(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_NONCE_LENGTH
}

const bridgeOnline: RuntimeProtectionBridgeOnlineMessage = {
  type: 'PROTECTION_BRIDGE_ONLINE',
  protocolVersion: PROTECTION_PROTOCOL_VERSION,
}
chrome.runtime.sendMessage(bridgeOnline)

window.addEventListener('message', (event) => {
  if (event.source !== window) return
  const data = event.data as
    | {
        type?: string
        localId?: string
        requestId?: string
        xdr?: string
        networkPassphrase?: string
        adapter?: unknown
      }
    | undefined
  // `localId`/`requestId` here is only the page/bridge boundary's own
  // correlation token for matching this response to the caller's promise —
  // it is never forwarded to the background and never treated as an
  // authoritative capability. The background generates its own requestId
  // (returned in SIGN_ACK below) and that is the only id used for pending
  // state, popup URLs, or decision binding.
  const localId = data?.localId ?? data?.requestId
  if (data?.type !== WINDOW_REQUEST_TYPE || !localId || !data.xdr || !isSigningAdapter(data.adapter)) {
    return
  }

  void (async () => {
    const signRequest: RuntimeSignRequestMessage = {
      type: 'SIGN_REQUEST',
      protocolVersion: SIGN_PROTOCOL_VERSION,
      xdr: data.xdr as string,
      networkPassphrase: data.networkPassphrase,
      adapter: data.adapter as SigningAdapter,
    }

    const ackOrRejection = await sendRuntimeMessage<RuntimeSignAckMessage | RuntimeSignRejectedMessage>(
      signRequest,
    )
    if (!ackOrRejection || ackOrRejection.type !== 'SIGN_ACK') {
      window.postMessage({ type: WINDOW_RESPONSE_TYPE, localId, outcome: 'cancel' }, '*')
      return
    }

    // Bounded by whichever deadline is sooner: the worker's own authoritative
    // deadline, or this bridge-side fallback that fires even if the worker
    // never answers another AWAIT_OUTCOME call again (e.g. uninstalled).
    const deadlineAt = Math.min(ackOrRejection.deadlineAt, Date.now() + BRIDGE_FALLBACK_DEADLINE_MS)
    const requestId = ackOrRejection.requestId
    const outcome = await awaitOutcome(requestId, deadlineAt, {
      sendMessage: (id) =>
        sendRuntimeMessage<AwaitOutcomeResponse>({ type: 'AWAIT_OUTCOME', requestId: id }),
    })

    window.postMessage({ type: WINDOW_RESPONSE_TYPE, localId, outcome }, '*')
  })()
})

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return
  const data = event.data as
    | {
        type?: string
        nonce?: unknown
        adapter?: unknown
        protocolVersion?: unknown
        status?: unknown
      }
    | undefined
  if (
    !data ||
    !isProtectionAdapter(data.adapter) ||
    data.protocolVersion !== PROTECTION_PROTOCOL_VERSION
  ) {
    return
  }

  if (data.type === WINDOW_PROTECTION_PROBE_TYPE && isNonce(data.nonce)) {
    const message: RuntimeProtectionHandshakeMessage = {
      type: 'PROTECTION_HANDSHAKE',
      nonce: data.nonce,
      adapter: data.adapter,
      protocolVersion: PROTECTION_PROTOCOL_VERSION,
    }
    chrome.runtime.sendMessage(message, (response: { accepted?: boolean } | undefined) => {
      if (chrome.runtime.lastError || response?.accepted !== true) return
      window.postMessage(
        {
          type: WINDOW_PROTECTION_RESPONSE_TYPE,
          nonce: data.nonce,
          adapter: data.adapter,
          protocolVersion: PROTECTION_PROTOCOL_VERSION,
        },
        window.location.origin,
      )
    })
    return
  }

  if (data.type === WINDOW_PROTECTION_ACK_TYPE && isNonce(data.nonce)) {
    const message: RuntimeProtectionHandshakeAckMessage = {
      type: 'PROTECTION_HANDSHAKE_ACK',
      nonce: data.nonce,
      adapter: data.adapter,
      protocolVersion: PROTECTION_PROTOCOL_VERSION,
    }
    chrome.runtime.sendMessage(message)
    return
  }

  if (
    data.type === WINDOW_PROTECTION_ADAPTER_STATUS_TYPE &&
    (data.status === 'adapter-incompatible' || data.status === 'unsupported')
  ) {
    const message: RuntimeProtectionAdapterStatusMessage = {
      type: 'PROTECTION_ADAPTER_STATUS',
      adapter: data.adapter,
      status: data.status,
      protocolVersion: PROTECTION_PROTOCOL_VERSION,
    }
    chrome.runtime.sendMessage(message)
  }
})
