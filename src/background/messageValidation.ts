import type {
  RuntimeAwaitOutcomeMessage,
  RuntimeDecisionMadeMessage,
  RuntimeProtectionAdapterStatusMessage,
  RuntimeProtectionBridgeOnlineMessage,
  RuntimeProtectionHandshakeAckMessage,
  RuntimeProtectionHandshakeMessage,
  RuntimeReviewRequestMessage,
  RuntimeSignRequestMessage,
} from '../intercept/protocol'
import { SIGN_PROTOCOL_VERSION } from '../signing/pendingRequestState'
import { PROTECTION_PROTOCOL_VERSION } from '../protection/protectionState'

// UUID request IDs are currently 36 characters. The larger bound preserves
// compatibility with other opaque ID formats without permitting unbounded
// values to reach pending state or popup URLs.
export const MAX_REQUEST_ID_LENGTH = 128

// Stellar transaction envelopes are far smaller in normal wallet flows. This
// limit leaves ample room for large envelopes while placing a hard bound on
// work handed to the XDR decoder.
export const MAX_XDR_LENGTH = 1024 * 1024

// Known Stellar passphrases are short, but custom networks may use their own.
// Keep them supported while preventing an unbounded parser argument.
export const MAX_NETWORK_PASSPHRASE_LENGTH = 256

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function isNonEmptyBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim().length > 0
  )
}

function isSigningAdapter(value: unknown): value is 'freighter' | 'albedo-popup' {
  return value === 'freighter' || value === 'albedo-popup'
}

/**
 * Validate an untrusted runtime value before XDR decoding or popup
 * creation. There is deliberately no `requestId` field: the page/bridge
 * boundary's correlation id never crosses into this message, and the
 * background is the sole generator of the authoritative request id
 * (returned in SIGN_ACK). A mismatched protocolVersion is checked by the
 * caller and answered with a typed SIGN_REJECTED, not silently ignored.
 */
export function isRuntimeSignRequestMessage(
  message: unknown,
): message is RuntimeSignRequestMessage {
  if (
    !isRecord(message) ||
    !hasOnlyKeys(message, ['type', 'protocolVersion', 'xdr', 'networkPassphrase', 'adapter']) ||
    message.type !== 'SIGN_REQUEST'
  ) {
    return false
  }

  if (typeof message.protocolVersion !== 'number' || !Number.isInteger(message.protocolVersion)) {
    return false
  }
  if (!isNonEmptyBoundedString(message.xdr, MAX_XDR_LENGTH)) return false
  if (!isSigningAdapter(message.adapter)) return false

  return (
    message.networkPassphrase === undefined ||
    isNonEmptyBoundedString(message.networkPassphrase, MAX_NETWORK_PASSPHRASE_LENGTH)
  )
}

/** Validate the bridge's resume/status handshake before reading durable pending state. */
export function isRuntimeAwaitOutcomeMessage(
  message: unknown,
): message is RuntimeAwaitOutcomeMessage {
  return (
    isRecord(message) &&
    hasOnlyKeys(message, ['type', 'requestId']) &&
    message.type === 'AWAIT_OUTCOME' &&
    isNonEmptyBoundedString(message.requestId, MAX_REQUEST_ID_LENGTH)
  )
}

/** Validate a popup decision before looking up or resolving pending state. */
export function isRuntimeDecisionMadeMessage(
  message: unknown,
): message is RuntimeDecisionMadeMessage {
  return (
    isRecord(message) &&
    hasOnlyKeys(message, ['type', 'protocolVersion', 'requestId', 'decision']) &&
    message.type === 'DECISION_MADE' &&
    message.protocolVersion === SIGN_PROTOCOL_VERSION &&
    isNonEmptyBoundedString(message.requestId, MAX_REQUEST_ID_LENGTH) &&
    (message.decision === 'proceed' || message.decision === 'cancel')
  )
}

/** Validate the popup's bounded request for worker-resident review data. */
export function isRuntimeReviewRequestMessage(
  message: unknown,
): message is RuntimeReviewRequestMessage {
  return (
    isRecord(message) &&
    hasOnlyKeys(message, ['type', 'protocolVersion', 'requestId']) &&
    message.type === 'GET_REVIEW' &&
    message.protocolVersion === SIGN_PROTOCOL_VERSION &&
    isNonEmptyBoundedString(message.requestId, MAX_REQUEST_ID_LENGTH)
  )
}

function isProtectionAdapter(value: unknown): value is 'freighter' | 'albedo-popup' {
  return value === 'freighter' || value === 'albedo-popup'
}

function isProtectionNonce(value: unknown): value is string {
  return isNonEmptyBoundedString(value, MAX_REQUEST_ID_LENGTH)
}

/** Validate the bridge's context-liveness signal before recording it. */
export function isRuntimeProtectionBridgeOnlineMessage(
  message: unknown,
): message is RuntimeProtectionBridgeOnlineMessage {
  return (
    isRecord(message) &&
    hasOnlyKeys(message, ['type', 'protocolVersion']) &&
    message.type === 'PROTECTION_BRIDGE_ONLINE' &&
    message.protocolVersion === PROTECTION_PROTOCOL_VERSION
  )
}

export function isRuntimeProtectionHandshakeMessage(
  message: unknown,
): message is RuntimeProtectionHandshakeMessage {
  return (
    isRecord(message) &&
    hasOnlyKeys(message, ['type', 'nonce', 'adapter', 'protocolVersion']) &&
    message.type === 'PROTECTION_HANDSHAKE' &&
    isProtectionNonce(message.nonce) &&
    isProtectionAdapter(message.adapter) &&
    message.protocolVersion === PROTECTION_PROTOCOL_VERSION
  )
}

export function isRuntimeProtectionHandshakeAckMessage(
  message: unknown,
): message is RuntimeProtectionHandshakeAckMessage {
  return (
    isRecord(message) &&
    hasOnlyKeys(message, ['type', 'nonce', 'adapter', 'protocolVersion']) &&
    message.type === 'PROTECTION_HANDSHAKE_ACK' &&
    isProtectionNonce(message.nonce) &&
    isProtectionAdapter(message.adapter) &&
    message.protocolVersion === PROTECTION_PROTOCOL_VERSION
  )
}

export function isRuntimeProtectionAdapterStatusMessage(
  message: unknown,
): message is RuntimeProtectionAdapterStatusMessage {
  return (
    isRecord(message) &&
    hasOnlyKeys(message, ['type', 'adapter', 'status', 'protocolVersion']) &&
    message.type === 'PROTECTION_ADAPTER_STATUS' &&
    isProtectionAdapter(message.adapter) &&
    (message.status === 'adapter-incompatible' || message.status === 'unsupported') &&
    message.protocolVersion === PROTECTION_PROTOCOL_VERSION
  )
}
