import type { RuntimeDecisionMadeMessage, RuntimeSignRequestMessage } from '../intercept/protocol'

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

function isNonEmptyBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim().length > 0
  )
}

/** Validate an untrusted runtime value before XDR decoding or popup creation. */
export function isRuntimeSignRequestMessage(
  message: unknown,
): message is RuntimeSignRequestMessage {
  if (!isRecord(message) || message.type !== 'SIGN_REQUEST') return false

  if (!isNonEmptyBoundedString(message.requestId, MAX_REQUEST_ID_LENGTH)) return false
  if (!isNonEmptyBoundedString(message.xdr, MAX_XDR_LENGTH)) return false

  return (
    message.networkPassphrase === undefined ||
    isNonEmptyBoundedString(message.networkPassphrase, MAX_NETWORK_PASSPHRASE_LENGTH)
  )
}

/** Validate a popup decision before looking up or resolving pending state. */
export function isRuntimeDecisionMadeMessage(
  message: unknown,
): message is RuntimeDecisionMadeMessage {
  return (
    isRecord(message) &&
    message.type === 'DECISION_MADE' &&
    isNonEmptyBoundedString(message.requestId, MAX_REQUEST_ID_LENGTH) &&
    (message.decision === 'proceed' || message.decision === 'cancel')
  )
}
