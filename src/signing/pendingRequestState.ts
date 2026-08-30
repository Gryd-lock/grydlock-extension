/**
 * Pure state for the one-shot signing protocol. Mirrors the split used by
 * src/protection/protectionState.ts: this module holds no chrome.* calls and
 * no resolver/callback functions (those cannot survive MV3 worker
 * suspension), only the serializable record shape, transition rules, and
 * admission/pruning policy that src/background/background.ts wires up.
 */
export const SIGN_PROTOCOL_VERSION = 1

// The worker is the deadline's source of truth: it is checked eagerly on
// every touchpoint (AWAIT_OUTCOME, DECISION_MADE, restore-after-restart)
// rather than relied on solely via a fire-and-forget timer, so correctness
// does not depend on a setTimeout surviving a worker restart.
export const REVIEW_DEADLINE_MS = 90_000

// How long a terminal record is kept after settlement so a replayed
// DECISION_MADE or a retried AWAIT_OUTCOME resolves idempotently instead of
// hitting "unknown request" once storage/memory has pruned it.
export const TOMBSTONE_TTL_MS = 120_000

export const MAX_PENDING_PER_FRAME = 5
export const MAX_PENDING_GLOBAL = 50

export type PendingState =
  | 'received'
  | 'validating'
  | 'assessing'
  | 'awaiting_review'
  | 'proceed'
  | 'cancel'
  | 'expired'
  | 'failed'

export type SigningAdapter = 'freighter' | 'albedo-popup'

export const TERMINAL_STATES: ReadonlySet<PendingState> = new Set([
  'proceed',
  'cancel',
  'expired',
  'failed',
])

export function isTerminal(state: PendingState): boolean {
  return TERMINAL_STATES.has(state)
}

export interface PendingRequestRecord {
  requestId: string
  adapter: SigningAdapter
  tabId: number
  frameId: number
  documentId?: string
  documentBound: boolean
  networkPassphrase?: string
  xdrDigest?: string
  windowId?: number
  state: PendingState
  protocolVersion: number
  createdAt: number
  deadlineAt: number
  settledAt?: number
}

const ALLOWED_TRANSITIONS: Record<PendingState, readonly PendingState[]> = {
  received: ['validating', 'failed', 'expired'],
  validating: ['assessing', 'failed', 'expired'],
  assessing: ['awaiting_review', 'failed', 'expired'],
  awaiting_review: ['proceed', 'cancel', 'expired', 'failed'],
  proceed: [],
  cancel: [],
  expired: [],
  failed: [],
}

export function canTransition(from: PendingState, to: PendingState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

/**
 * The first valid terminal transition wins; replay is a no-op. A repeat of
 * the *same* terminal state the record already holds is treated as an
 * idempotent replay (returns the unchanged record) rather than a rejected
 * transition, so a retried AWAIT_OUTCOME or duplicate DECISION_MADE never
 * needs special-casing by the caller. Any other transition attempted from a
 * terminal state, or a transition not present in the table, is rejected
 * (returns null) and must be treated as a no-op by the caller.
 */
export function applyTransition(
  record: PendingRequestRecord,
  to: PendingState,
  now: number,
  patch: Partial<PendingRequestRecord> = {},
): PendingRequestRecord | null {
  if (record.state === to) return record
  if (!canTransition(record.state, to)) return null
  return {
    ...record,
    ...patch,
    state: to,
    settledAt: isTerminal(to) ? now : record.settledAt,
  }
}

export function isExpired(record: PendingRequestRecord, now: number): boolean {
  return !isTerminal(record.state) && now > record.deadlineAt
}

export function shouldPrune(record: PendingRequestRecord, now: number): boolean {
  return isTerminal(record.state) && record.settledAt !== undefined
    ? now - record.settledAt > TOMBSTONE_TTL_MS
    : false
}

export type AdmissionResult = 'ok' | 'frame-limit' | 'global-limit'

/** Rejects immediately (no popup opened) once bounds are hit; active records only, terminal tombstones don't count against the cap. */
export function admissionCheck(
  activeRecords: readonly PendingRequestRecord[],
  tabId: number,
  frameId: number,
): AdmissionResult {
  if (activeRecords.length >= MAX_PENDING_GLOBAL) return 'global-limit'
  const frameActive = activeRecords.filter(
    (record) => record.tabId === tabId && record.frameId === frameId,
  )
  if (frameActive.length >= MAX_PENDING_PER_FRAME) return 'frame-limit'
  return 'ok'
}

export function outcomeForState(state: PendingState): 'proceed' | 'cancel' {
  return state === 'proceed' ? 'proceed' : 'cancel'
}

const SIGNING_ADAPTERS: readonly SigningAdapter[] = ['freighter', 'albedo-popup']
const PENDING_STATES: readonly PendingState[] = [
  'received',
  'validating',
  'assessing',
  'awaiting_review',
  'proceed',
  'cancel',
  'expired',
  'failed',
]

/** Hand-rolled runtime guard for chrome.storage.session deserialization, mirroring validateProtectionRecord. */
export function validatePendingRequestRecord(value: unknown): PendingRequestRecord | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<PendingRequestRecord>
  if (
    typeof record.requestId !== 'string' ||
    record.requestId.length === 0 ||
    record.requestId.length > 128
  ) {
    return null
  }
  if (!SIGNING_ADAPTERS.includes(record.adapter as SigningAdapter)) return null
  if (typeof record.tabId !== 'number' || !Number.isInteger(record.tabId)) return null
  if (typeof record.frameId !== 'number' || !Number.isInteger(record.frameId)) return null
  if (typeof record.documentBound !== 'boolean') return null
  if (!PENDING_STATES.includes(record.state as PendingState)) return null
  if (typeof record.protocolVersion !== 'number' || !Number.isInteger(record.protocolVersion)) {
    return null
  }
  if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) return null
  if (typeof record.deadlineAt !== 'number' || !Number.isFinite(record.deadlineAt)) return null
  if (record.documentId !== undefined && typeof record.documentId !== 'string') return null
  if (record.networkPassphrase !== undefined && typeof record.networkPassphrase !== 'string') {
    return null
  }
  if (record.xdrDigest !== undefined && typeof record.xdrDigest !== 'string') return null
  if (record.windowId !== undefined && !Number.isInteger(record.windowId)) return null
  if (record.settledAt !== undefined && typeof record.settledAt !== 'number') return null

  return {
    requestId: record.requestId,
    adapter: record.adapter as SigningAdapter,
    tabId: record.tabId,
    frameId: record.frameId,
    documentId: record.documentId,
    documentBound: record.documentBound,
    networkPassphrase: record.networkPassphrase,
    xdrDigest: record.xdrDigest,
    windowId: record.windowId,
    state: record.state as PendingState,
    protocolVersion: record.protocolVersion,
    createdAt: record.createdAt,
    deadlineAt: record.deadlineAt,
    settledAt: record.settledAt,
  }
}
