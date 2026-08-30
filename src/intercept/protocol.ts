import { SIGN_PROTOCOL_VERSION, type SigningAdapter } from '../signing/pendingRequestState'

export type Decision = 'proceed' | 'cancel'
export type Outcome = 'allow' | Decision

export { SIGN_PROTOCOL_VERSION }

/**
 * Deadlines are layered so a lower layer's fail-closed cancel arrives before
 * a higher layer gives up unilaterally: background's REVIEW_DEADLINE_MS
 * (src/signing/pendingRequestState.ts, 90s) is authoritative; the bridge's
 * fallback covers a missing/unresponsive background; the page's covers a
 * missing/unresponsive bridge (e.g. a stale content script after an
 * extension update). Each is a final backstop, not the common path.
 */
export const BRIDGE_FALLBACK_DEADLINE_MS = 100_000
export const PAGE_DEADLINE_MS = 120_000

export const WINDOW_REQUEST_TYPE = 'GRYDLOCK_REQUEST_OUTCOME'
export const WINDOW_RESPONSE_TYPE = 'GRYDLOCK_OUTCOME_RESPONSE'
export const WINDOW_PROTECTION_PROBE_TYPE = 'GRYDLOCK_PROTECTION_PROBE'
export const WINDOW_PROTECTION_RESPONSE_TYPE = 'GRYDLOCK_PROTECTION_RESPONSE'
export const WINDOW_PROTECTION_ACK_TYPE = 'GRYDLOCK_PROTECTION_ACK'
export const WINDOW_PROTECTION_ADAPTER_STATUS_TYPE = 'GRYDLOCK_PROTECTION_ADAPTER_STATUS'

export type ProtectionAdapter = 'freighter' | 'albedo-popup'

export interface RuntimeProtectionBridgeOnlineMessage {
  type: 'PROTECTION_BRIDGE_ONLINE'
  protocolVersion: number
}

export interface RuntimeProtectionHandshakeMessage {
  type: 'PROTECTION_HANDSHAKE'
  nonce: string
  adapter: ProtectionAdapter
  protocolVersion: number
}

export interface RuntimeProtectionHandshakeAckMessage {
  type: 'PROTECTION_HANDSHAKE_ACK'
  nonce: string
  adapter: ProtectionAdapter
  protocolVersion: number
}

export interface RuntimeProtectionAdapterStatusMessage {
  type: 'PROTECTION_ADAPTER_STATUS'
  adapter: ProtectionAdapter
  status: 'adapter-incompatible' | 'unsupported'
  protocolVersion: number
}

export interface RuntimeProtectionStatusQueryMessage {
  type: 'GET_PROTECTION_STATUS'
  tabId?: number
}

export interface RuntimeClearDiagnosticsMessage {
  type: 'CLEAR_DIAGNOSTICS'
}

export interface RuntimeExportDiagnosticsMessage {
  type: 'EXPORT_DIAGNOSTICS'
}

/**
 * The page/bridge boundary's own correlation id (`localId` in
 * mainWorldEntry.ts/albedoMainWorldEntry.ts) never crosses into this
 * message: it is not a parameter here and the background never sees it. The
 * background generates its own `requestId` in SIGN_ACK and that id — never
 * anything page-supplied — is the only identifier treated as authoritative
 * for pending state, popup URLs, or decision binding.
 */
export interface RuntimeSignRequestMessage {
  type: 'SIGN_REQUEST'
  protocolVersion: number
  xdr: string
  networkPassphrase?: string
  adapter: SigningAdapter
}

/** Closes the SIGN_REQUEST message port immediately; the worker is not required to stay alive for the rest of the review. */
export interface RuntimeSignAckMessage {
  type: 'SIGN_ACK'
  requestId: string
  deadlineAt: number
}

/** A typed, explicit rejection — never a silent bypass — for an incompatible protocol version, unbindable sender, or admission-control limit. */
export interface RuntimeSignRejectedMessage {
  type: 'SIGN_REJECTED'
  reason: 'protocol-incompatible' | 'sender-unbound' | 'frame-limit' | 'global-limit'
}

/**
 * The bridge's resume/status handshake: safe to call repeatedly (idempotent
 * against a terminal record) and safe to retry after a worker restart,
 * since the answer is read from durable state, not from a resolver that
 * could not have survived suspension.
 */
export interface RuntimeAwaitOutcomeMessage {
  type: 'AWAIT_OUTCOME'
  requestId: string
}

export interface RuntimeSignOutcomeMessage {
  type: 'SIGN_OUTCOME'
  requestId: string
  outcome: Outcome
}

export interface RuntimeDecisionMadeMessage {
  type: 'DECISION_MADE'
  protocolVersion: number
  requestId: string
  decision: Decision
}

export interface RuntimeReviewRequestMessage {
  type: 'GET_REVIEW'
  protocolVersion: number
  requestId: string
}

export interface RuntimeReviewResponseMessage {
  type: 'REVIEW_DATA'
  requestId: string
  review?: import('../review/model').AggregatedReview
}

export interface RuntimeSignRequestInfo {
  destination: string
  kind: 'payment' | 'contractInvocation'
  asset?: string
  function?: string
  score: number
}
