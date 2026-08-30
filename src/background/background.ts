import { getScore } from '../adapter/oracleAdapter'
import {
  clearDiagnostics,
  exportDiagnostics,
  recordDiagnosticEvent,
} from '../diagnostics/diagnosticsStore'
import { buildAggregatedReview } from '../intercept/resolveOutcome'
import type {
  Decision,
  Outcome,
  RuntimeAwaitOutcomeMessage,
  RuntimeDecisionMadeMessage,
  RuntimeReviewRequestMessage,
  RuntimeReviewResponseMessage,
  RuntimeSignAckMessage,
  RuntimeSignOutcomeMessage,
  RuntimeSignRejectedMessage,
  RuntimeSignRequestMessage,
  RuntimeProtectionStatusQueryMessage,
} from '../intercept/protocol'
import type { AggregatedReview } from '../review/model'
import { recordDecision } from '../lib/history'
import { tierForScore } from '../lib/tiers'
import {
  isRuntimeAwaitOutcomeMessage,
  isRuntimeDecisionMadeMessage,
  isRuntimeProtectionAdapterStatusMessage,
  isRuntimeProtectionBridgeOnlineMessage,
  isRuntimeProtectionHandshakeAckMessage,
  isRuntimeProtectionHandshakeMessage,
  isRuntimeReviewRequestMessage,
  isRuntimeSignRequestMessage,
} from './messageValidation'
import {
  PROTECTION_PROTOCOL_VERSION,
  recordKey,
  snapshotForRecords,
  staleRecords,
  validateProtectionRecord,
  type ProtectionAdapter,
  type ProtectionRecord,
  type ProtectionSnapshot,
} from '../protection/protectionState'
import {
  SIGN_PROTOCOL_VERSION,
  REVIEW_DEADLINE_MS,
  admissionCheck,
  applyTransition,
  isExpired,
  isTerminal,
  outcomeForState,
  shouldPrune,
  validatePendingRequestRecord,
  type PendingRequestRecord,
  type PendingState,
} from '../signing/pendingRequestState'

export const DEFAULT_TIMEOUT_MS = REVIEW_DEADLINE_MS
export const PROTECTION_STORAGE_KEY = 'protectionStateV1'
export const PENDING_REQUEST_STORAGE_KEY = 'pendingRequestStateV1'
const HANDSHAKE_TTL_MS = 5_000
const MAX_PENDING_HANDSHAKES = 100

interface PendingSignEntry {
  record: PendingRequestRecord
  review?: AggregatedReview
  resolvers: Array<(outcome: Outcome) => void>
}

/**
 * Resolver functions never survive worker suspension, so they live only in
 * this in-memory map, keyed by the background-generated `requestId` — the
 * only identifier ever treated as authoritative. `entry.record` is the
 * serializable projection persisted to chrome.storage.session (see
 * persistPendingRequests/restorePendingRequests below); review content
 * never reaches the popup URL and the page/bridge boundary's own
 * correlation id never reaches this map at all.
 */
export const pendingSignRequests = new Map<string, PendingSignEntry>()

const protectionRecords = new Map<string, ProtectionRecord>()
const bridgeContexts = new Map<string, { origin: string; documentId?: string }>()
const pendingHandshakes = new Map<
  string,
  {
    tabId: number
    frameId: number
    adapter: ProtectionAdapter
    origin: string
    documentId?: string
    expiresAt: number
  }
>()

function diagnosticsHealth() {
  const statuses = [...protectionRecords.values()].map((record) => record.status)
  return {
    interception: statuses.includes('protected')
      ? 'ok'
      : statuses.includes('stale')
        ? 'degraded'
        : 'unknown',
    bridge: bridgeContexts.size > 0 ? 'ok' : 'unknown',
    background: 'ok',
    oracle: 'unknown',
    storage: 'ok',
  } as const
}

function persistProtectionRecords(): void {
  const session = chrome.storage?.session
  if (!session) return
  void session.set({ [PROTECTION_STORAGE_KEY]: [...protectionRecords.values()] }).catch(() => {
    void recordDiagnosticEvent('storage.write_failure').catch(() => {})
  })
}

function setProtectionRecord(record: ProtectionRecord): void {
  protectionRecords.set(recordKey(record.tabId, record.frameId, record.adapter), record)
  persistProtectionRecords()
}

function clearPendingHandshakes(tabId?: number): void {
  for (const [nonce, pending] of pendingHandshakes) {
    if (tabId === undefined || pending.tabId === tabId) pendingHandshakes.delete(nonce)
  }
}

function clearBridgeContexts(tabId?: number): void {
  for (const key of bridgeContexts.keys()) {
    if (tabId === undefined || key.startsWith(`${tabId}:`)) bridgeContexts.delete(key)
  }
}

function discardExpiredHandshakes(now: number): void {
  for (const [nonce, pending] of pendingHandshakes) {
    if (pending.expiresAt < now) pendingHandshakes.delete(nonce)
  }
}

async function restoreProtectionRecords(): Promise<void> {
  const session = chrome.storage?.session
  if (!session) return
  try {
    const stored = await session.get(PROTECTION_STORAGE_KEY)
    const values = Array.isArray(stored[PROTECTION_STORAGE_KEY])
      ? stored[PROTECTION_STORAGE_KEY]
      : []
    for (const record of staleRecords(
      values.map(validateProtectionRecord).filter(Boolean) as ProtectionRecord[],
    )) {
      protectionRecords.set(recordKey(record.tabId, record.frameId, record.adapter), record)
    }
    persistProtectionRecords()
  } catch {
    void recordDiagnosticEvent('storage.write_failure').catch(() => {})
  }
}

function senderLocation(sender: chrome.runtime.MessageSender): {
  tabId: number
  frameId: number
} | null {
  const tabId = sender.tab?.id
  if (!Number.isInteger(tabId)) return null
  return { tabId: tabId as number, frameId: sender.frameId ?? 0 }
}

function senderOrigin(sender: chrome.runtime.MessageSender): string | null {
  const candidate = sender.url ?? sender.tab?.url
  if (!candidate) return null
  try {
    const parsed = new URL(candidate)
    return parsed.origin === 'null' ? null : parsed.origin
  } catch {
    return null
  }
}

function permissionPatternForOrigin(origin: string): string | null {
  try {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return `${parsed.protocol}//${parsed.hostname}/*`
  } catch {
    return null
  }
}

function rememberBridgeContext(sender: chrome.runtime.MessageSender): void {
  const location = senderLocation(sender)
  const origin = senderOrigin(sender)
  if (!location || !origin) return
  bridgeContexts.set(`${location.tabId}:${location.frameId}`, {
    origin,
    documentId: sender.documentId,
  })
}

async function hasCurrentSitePermission(sender: chrome.runtime.MessageSender): Promise<boolean> {
  const origin = senderOrigin(sender)
  return origin ? hasOriginPermission(origin) : false
}

async function hasOriginPermission(origin: string): Promise<boolean> {
  const pattern = permissionPatternForOrigin(origin)
  if (!pattern || !chrome.permissions?.contains) return false
  try {
    return await chrome.permissions.contains({ origins: [pattern] })
  } catch {
    return false
  }
}

function currentSnapshot(
  sender: chrome.runtime.MessageSender,
  requestedTabId?: unknown,
): ProtectionSnapshot {
  const location = senderLocation(sender)
  const hasExplicitTab = Number.isInteger(requestedTabId)
  const tabId = hasExplicitTab ? (requestedTabId as number) : location?.tabId
  const frameId = hasExplicitTab ? undefined : location?.frameId
  if (tabId === undefined) {
    return { status: 'worker-unavailable', adapter: null, checkedAt: null, freshUntil: null }
  }
  const records = [...protectionRecords.values()].filter(
    (record) => record.tabId === tabId && (frameId === undefined || record.frameId === frameId),
  )
  const hasBridge = [...bridgeContexts.keys()].some(
    (key) =>
      key === `${tabId}:${frameId}` || (frameId === undefined && key.startsWith(`${tabId}:`)),
  )
  if (records.length === 0 && hasBridge) {
    return { status: 'unknown', adapter: null, checkedAt: null, freshUntil: null }
  }
  return snapshotForRecords(records, Date.now())
}

async function handleProtectionHandshake(
  message: { nonce: string; adapter: ProtectionAdapter },
  sender: chrome.runtime.MessageSender,
): Promise<{ accepted: boolean }> {
  const location = senderLocation(sender)
  if (!location) return { accepted: false }
  const currentTime = Date.now()
  discardExpiredHandshakes(currentTime)
  if (pendingHandshakes.size >= MAX_PENDING_HANDSHAKES) {
    void recordDiagnosticEvent('protection.handshake.failure').catch(() => {})
    return { accepted: false }
  }
  if (!(await hasCurrentSitePermission(sender))) {
    setProtectionRecord({
      ...location,
      adapter: message.adapter,
      status: 'permission-denied',
      protocolVersion: PROTECTION_PROTOCOL_VERSION,
      checkedAt: Date.now(),
    })
    return { accepted: false }
  }

  const origin = senderOrigin(sender)
  if (!origin || pendingHandshakes.has(message.nonce)) {
    void recordDiagnosticEvent('protection.handshake.failure').catch(() => {})
    return { accepted: false }
  }
  rememberBridgeContext(sender)

  pendingHandshakes.set(message.nonce, {
    ...location,
    adapter: message.adapter,
    origin,
    documentId: sender.documentId,
    expiresAt: currentTime + HANDSHAKE_TTL_MS,
  })
  return { accepted: true }
}

function handleProtectionHandshakeAck(
  message: { nonce: string; adapter: ProtectionAdapter },
  sender: chrome.runtime.MessageSender,
): void {
  const pending = pendingHandshakes.get(message.nonce)
  pendingHandshakes.delete(message.nonce)
  const location = senderLocation(sender)
  if (
    !pending ||
    !location ||
    pending.adapter !== message.adapter ||
    pending.tabId !== location.tabId ||
    pending.frameId !== location.frameId ||
    pending.origin !== senderOrigin(sender) ||
    pending.documentId !== sender.documentId ||
    pending.expiresAt < Date.now()
  ) {
    void recordDiagnosticEvent('protection.handshake.failure').catch(() => {})
    return
  }
  const existing = protectionRecords.get(recordKey(pending.tabId, pending.frameId, pending.adapter))
  // A concrete route failure remains non-protective for the lifetime of this document.
  // A generic heartbeat cannot erase it; navigation creates a new document and resets it.
  if (existing?.status === 'adapter-incompatible' || existing?.status === 'unsupported') return
  setProtectionRecord({
    tabId: pending.tabId,
    frameId: pending.frameId,
    adapter: pending.adapter,
    status: 'protected',
    protocolVersion: PROTECTION_PROTOCOL_VERSION,
    checkedAt: Date.now(),
  })
  void recordDiagnosticEvent('protection.handshake.success').catch(() => {})
}

const protectionRestore = restoreProtectionRecords()

function persistPendingRequests(): void {
  const session = chrome.storage?.session
  if (!session) return
  const records = [...pendingSignRequests.values()].map((entry) => entry.record)
  void session.set({ [PENDING_REQUEST_STORAGE_KEY]: records }).catch(() => {
    void recordDiagnosticEvent('storage.write_failure').catch(() => {})
  })
}

async function restorePendingRequests(): Promise<void> {
  const session = chrome.storage?.session
  if (!session) return
  try {
    const stored = await session.get(PENDING_REQUEST_STORAGE_KEY)
    const values = Array.isArray(stored[PENDING_REQUEST_STORAGE_KEY])
      ? stored[PENDING_REQUEST_STORAGE_KEY]
      : []
    const now = Date.now()
    for (const raw of values) {
      const record = validatePendingRequestRecord(raw)
      if (!record || shouldPrune(record, now)) continue
      // A worker restart never silently loses a deadline: any record whose
      // absolute deadline already passed is settled 'expired' on restore,
      // not left dangling for a resume attempt that could never succeed.
      const effective = isExpired(record, now)
        ? (applyTransition(record, 'expired', now) ?? record)
        : record
      pendingSignRequests.set(effective.requestId, { record: effective, resolvers: [] })
    }
    persistPendingRequests()
  } catch {
    void recordDiagnosticEvent('storage.write_failure').catch(() => {})
  }
}

const pendingRequestsRestore = restorePendingRequests()

function pruneStalePendingRequests(): void {
  const now = Date.now()
  let changed = false
  for (const [requestId, entry] of pendingSignRequests) {
    if (isExpired(entry.record, now)) {
      settlePendingRequest(requestId, 'expired')
      changed = true
      continue
    }
    if (shouldPrune(entry.record, now)) {
      pendingSignRequests.delete(requestId)
      changed = true
    }
  }
  if (changed) persistPendingRequests()
}

function transitionPendingRequest(
  requestId: string,
  next: PendingState,
  patch: Partial<PendingRequestRecord> = {},
): PendingRequestRecord | undefined {
  const entry = pendingSignRequests.get(requestId)
  if (!entry) return undefined
  const updated = applyTransition(entry.record, next, Date.now(), patch)
  if (!updated) return undefined
  entry.record = updated
  persistPendingRequests()
  return updated
}

/** The first valid terminal transition wins; every later call for the same requestId is a no-op against an already-settled record. */
function settlePendingRequest(requestId: string, state: PendingState): void {
  const entry = pendingSignRequests.get(requestId)
  if (!entry) return
  const alreadySettled = entry.record.state === state
  const updated = applyTransition(entry.record, state, Date.now())
  if (!updated) return
  entry.record = updated
  persistPendingRequests()
  if (!alreadySettled && (state === 'proceed' || state === 'cancel') && entry.review) {
    recordFirstDecision(entry.review, state)
  }
  const outcome = outcomeForState(state)
  const resolvers = entry.resolvers
  entry.resolvers = []
  for (const resolve of resolvers) resolve(outcome)
  clearBadgeIfIdle()
}

function createPopupWindow(requestId: string): Promise<chrome.windows.Window> {
  const params = new URLSearchParams({ mode: 'intercept', requestId })
  return new Promise((resolve, reject) => {
    try {
      chrome.windows.create(
        {
          url: chrome.runtime.getURL(`src/popup/index.html?${params.toString()}`),
          type: 'popup',
          width: 440,
          height: 680,
        },
        (createdWindow) => {
          if (chrome.runtime.lastError || !createdWindow) {
            reject(chrome.runtime.lastError ?? new Error('popup creation failed'))
            return
          }
          resolve(createdWindow)
        },
      )
    } catch (error) {
      reject(error)
    }
  })
}

/** windowId binds a pending request to its exact review popup ("review window"). First legitimate contact binds it (TOFU) — safe because requestId is an unguessable, never-page-visible secret, so only the correct popup can reach this at all; every later message must match exactly. */
function bindPopupWindow(requestId: string, windowId: number): void {
  const entry = pendingSignRequests.get(requestId)
  if (!entry || entry.record.windowId !== undefined) return
  entry.record = { ...entry.record, windowId }
  persistPendingRequests()
}

/** Terminal (tombstoned) entries are kept around for replay/idempotency, so "idle" means no non-terminal entry remains — not an empty map. */
function clearBadgeIfIdle() {
  const hasActive = [...pendingSignRequests.values()].some((entry) => !isTerminal(entry.record.state))
  if (!hasActive) {
    chrome.action.setBadgeText({ text: '' })
  }
}

function scoreForSeverity(severity: AggregatedReview['severity']): number {
  switch (severity) {
    case 'critical':
      return 85
    case 'high':
      return 60
    case 'warning':
      return 35
    default:
      return 10
  }
}

/**
 * Preserve the existing on-device history contract without persisting raw XDR,
 * contract identifiers, claimable-balance IDs, memos, or semantic findings.
 */
function recordFirstDecision(review: AggregatedReview, decision: Decision) {
  const evidence = review.evidence.find(
    (item) =>
      item.status === 'available' && item.target.type === 'account' && item.score !== undefined,
  )
  if (!evidence || evidence.score === undefined) return

  void recordDecision({
    destination: evidence.target.value,
    asset: evidence.target.asset,
    score: evidence.score,
    tier: tierForScore(evidence.score).tier,
    decision,
    timestamp: Date.now(),
  }).catch(() => {})
}

/**
 * Admits a SIGN_REQUEST: validates protocol/sender, enforces admission
 * limits, then persists durable pending state *before* building the review
 * or opening the popup. Responds with SIGN_ACK immediately once the request
 * is durably recorded — it does not wait for a user decision, so this
 * message port closes quickly and the worker is not required to stay alive
 * for the whole review. The caller resumes/awaits the eventual decision via
 * AWAIT_OUTCOME (handleAwaitOutcome), which is safe to call before, during,
 * or after a worker restart because it only ever reads durable state.
 */
function handleSignRequest(
  message: RuntimeSignRequestMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: RuntimeSignAckMessage | RuntimeSignRejectedMessage) => void,
): void {
  let responded = false
  const respondOnce = (response: RuntimeSignAckMessage | RuntimeSignRejectedMessage) => {
    if (responded) return
    responded = true
    sendResponse(response)
  }

  if (message.protocolVersion !== SIGN_PROTOCOL_VERSION) {
    respondOnce({ type: 'SIGN_REJECTED', reason: 'protocol-incompatible' })
    return
  }
  const location = senderLocation(sender)
  if (!location) {
    respondOnce({ type: 'SIGN_REJECTED', reason: 'sender-unbound' })
    return
  }

  void pendingRequestsRestore
    .then(async () => {
      pruneStalePendingRequests()

      const activeRecords = [...pendingSignRequests.values()]
        .map((entry) => entry.record)
        .filter((record) => !isTerminal(record.state))
      const admission = admissionCheck(activeRecords, location.tabId, location.frameId)
      if (admission !== 'ok') {
        void recordDiagnosticEvent('signing.request.admission_rejected').catch(() => {})
        respondOnce({
          type: 'SIGN_REJECTED',
          reason: admission === 'frame-limit' ? 'frame-limit' : 'global-limit',
        })
        return
      }

      const now = Date.now()
      const requestId = crypto.randomUUID()
      const record: PendingRequestRecord = {
        requestId,
        adapter: message.adapter,
        tabId: location.tabId,
        frameId: location.frameId,
        documentId: sender.documentId,
        documentBound: sender.documentId !== undefined,
        networkPassphrase: message.networkPassphrase,
        state: 'received',
        protocolVersion: SIGN_PROTOCOL_VERSION,
        createdAt: now,
        deadlineAt: now + DEFAULT_TIMEOUT_MS,
      }
      pendingSignRequests.set(requestId, { record, resolvers: [] })
      // Durable before any decode/scoring/UI work — a worker restart mid-decode
      // still knows this request exists even if the review itself is lost.
      persistPendingRequests()

      respondOnce({ type: 'SIGN_ACK', requestId, deadlineAt: record.deadlineAt })

      transitionPendingRequest(requestId, 'validating')
      const review = await buildAggregatedReview(
        message.xdr,
        // The current local adapter only accepts account strings. Keep that
        // projection here, after the review engine has enforced a typed,
        // network-scoped account target.
        { getScore: (target) => getScore(target.value) },
        message.networkPassphrase,
      )

      if (!review) {
        settlePendingRequest(requestId, 'failed')
        return
      }

      transitionPendingRequest(requestId, 'assessing')
      const withDigest = transitionPendingRequest(requestId, 'awaiting_review', {
        xdrDigest: review.review.xdrDigest,
      })
      if (!withDigest) return // already settled (e.g. tab closed/navigated while decoding)

      const entry = pendingSignRequests.get(requestId)
      if (entry) entry.review = review

      const score = scoreForSeverity(review.severity)
      const tierInfo = tierForScore(score)
      chrome.action.setBadgeText({ text: '!' })
      chrome.action.setBadgeBackgroundColor({ color: tierInfo.colour })

      try {
        const popupWindow = await createPopupWindow(requestId)
        if (typeof popupWindow.id === 'number') bindPopupWindow(requestId, popupWindow.id)
      } catch {
        settlePendingRequest(requestId, 'failed')
      }
    })
    .catch(() => {
      respondOnce({ type: 'SIGN_REJECTED', reason: 'sender-unbound' })
    })
}

/** The bridge's resume/status handshake. Safe to call repeatedly and safe to retry after a worker restart: the answer always comes from durable state, never from a resolver that could not have survived suspension. */
function handleAwaitOutcome(
  message: RuntimeAwaitOutcomeMessage,
  sendResponse: (response: RuntimeSignOutcomeMessage) => void,
): void {
  void pendingRequestsRestore.then(() => {
    pruneStalePendingRequests()
    const entry = pendingSignRequests.get(message.requestId)
    if (!entry) {
      sendResponse({ type: 'SIGN_OUTCOME', requestId: message.requestId, outcome: 'cancel' })
      return
    }
    if (isTerminal(entry.record.state)) {
      sendResponse({
        type: 'SIGN_OUTCOME',
        requestId: message.requestId,
        outcome: outcomeForState(entry.record.state),
      })
      return
    }
    entry.resolvers.push((outcome) =>
      sendResponse({ type: 'SIGN_OUTCOME', requestId: message.requestId, outcome }),
    )
  })
}

/**
 * Popup-originated read. Binds (or checks) the review window the same way
 * handleDecisionMade does, so copying a review URL into another window
 * reveals no transaction: a windowId mismatch gets an empty response, not
 * review content.
 */
function handleGetReview(
  message: RuntimeReviewRequestMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: RuntimeReviewResponseMessage) => void,
): void {
  void pendingRequestsRestore.then(() => {
    const entry = pendingSignRequests.get(message.requestId)
    const senderWindowId = sender.tab?.windowId
    if (!entry || typeof senderWindowId !== 'number') {
      sendResponse({ type: 'REVIEW_DATA', requestId: message.requestId })
      return
    }
    if (entry.record.windowId === undefined) {
      bindPopupWindow(message.requestId, senderWindowId)
    } else if (entry.record.windowId !== senderWindowId) {
      void recordDiagnosticEvent('signing.review.window_mismatch').catch(() => {})
      sendResponse({ type: 'REVIEW_DATA', requestId: message.requestId })
      return
    }
    sendResponse({ type: 'REVIEW_DATA', requestId: message.requestId, review: entry.review })
  })
}

/**
 * Popup-originated decision. A decision is only honored when: the record is
 * still 'awaiting_review' (not already terminal, not yet ready — replay and
 * premature decisions are both no-ops), and the sender's own window matches
 * the bound review window (or is the first legitimate contact). Nothing
 * about the dApp tab/frame/document is re-checked here — that binding is
 * enforced by tab close/navigation invalidation below, which settles the
 * request the moment the originating context goes away.
 */
function handleDecisionMade(
  message: RuntimeDecisionMadeMessage,
  sender: chrome.runtime.MessageSender,
): void {
  void pendingRequestsRestore.then(() => {
    pruneStalePendingRequests()
    const entry = pendingSignRequests.get(message.requestId)
    if (!entry || entry.record.state !== 'awaiting_review') return

    const senderWindowId = sender.tab?.windowId
    if (typeof senderWindowId !== 'number') return
    if (entry.record.windowId === undefined) {
      bindPopupWindow(message.requestId, senderWindowId)
    } else if (entry.record.windowId !== senderWindowId) {
      void recordDiagnosticEvent('signing.decision.window_mismatch').catch(() => {})
      return
    }

    settlePendingRequest(message.requestId, message.decision)
  })
}

/** Any pending request bound to this tab/frame is invalidated: an originating tab closing or navigating away can no longer be released or approved. */
function invalidatePendingRequestsForTab(tabId: number): void {
  void pendingRequestsRestore.then(() => {
    for (const [requestId, entry] of pendingSignRequests) {
      if (entry.record.tabId === tabId && !isTerminal(entry.record.state)) {
        settlePendingRequest(requestId, 'cancel')
      }
    }
  })
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (isRuntimeSignRequestMessage(message)) {
    handleSignRequest(message, _sender, sendResponse)
    return true
  }

  if (isRuntimeAwaitOutcomeMessage(message)) {
    handleAwaitOutcome(message, sendResponse)
    return true
  }

  if (isRuntimeReviewRequestMessage(message)) {
    handleGetReview(message, _sender, sendResponse)
    return true
  }

  if (isRuntimeDecisionMadeMessage(message)) {
    handleDecisionMade(message, _sender)
  }

  if (isRuntimeProtectionHandshakeMessage(message)) {
    void protectionRestore
      .then(() => handleProtectionHandshake(message, _sender))
      .then(sendResponse)
      .catch(() => sendResponse({ accepted: false }))
    return true
  }

  if (isRuntimeProtectionBridgeOnlineMessage(message)) {
    void protectionRestore.then(() => rememberBridgeContext(_sender))
    return undefined
  }

  if (isRuntimeProtectionHandshakeAckMessage(message)) {
    void protectionRestore.then(() => handleProtectionHandshakeAck(message, _sender))
    return undefined
  }

  if (isRuntimeProtectionAdapterStatusMessage(message)) {
    void protectionRestore.then(() => {
      const location = senderLocation(_sender)
      if (!location) return
      rememberBridgeContext(_sender)
      setProtectionRecord({
        ...location,
        adapter: message.adapter,
        status: message.status,
        protocolVersion: PROTECTION_PROTOCOL_VERSION,
        checkedAt: Date.now(),
      })
      void recordDiagnosticEvent('protection.handshake.failure').catch(() => {})
    })
    return undefined
  }

  if (
    (message as RuntimeProtectionStatusQueryMessage | undefined)?.type === 'GET_PROTECTION_STATUS'
  ) {
    void protectionRestore.then(() =>
      sendResponse(
        currentSnapshot(_sender, (message as RuntimeProtectionStatusQueryMessage).tabId),
      ),
    )
    return true
  }

  if ((message as { type?: string } | undefined)?.type === 'CLEAR_DIAGNOSTICS') {
    void clearDiagnostics().then(
      () => sendResponse({ cleared: true }),
      () => sendResponse({ cleared: false }),
    )
    return true
  }

  if ((message as { type?: string } | undefined)?.type === 'EXPORT_DIAGNOSTICS') {
    void exportDiagnostics(diagnosticsHealth()).then(sendResponse, () => sendResponse(undefined))
    return true
  }

  return undefined
})

void recordDiagnosticEvent('runtime.worker_start').catch(() => {})

async function updatePermissionState(restored: boolean): Promise<void> {
  let changed = false
  for (const [key, record] of protectionRecords) {
    const bridge = bridgeContexts.get(`${record.tabId}:${record.frameId}`)
    // A worker restart already makes records stale and intentionally discards origins. Never
    // reconstruct browsing history just to refine an already non-protective status.
    if (!bridge) continue
    const allowed = await hasOriginPermission(bridge.origin)
    if (!restored && !allowed && record.status !== 'permission-denied') {
      protectionRecords.set(key, { ...record, status: 'permission-denied' })
      clearPendingHandshakes(record.tabId)
      changed = true
    }
    if (restored && allowed && record.status === 'permission-denied') {
      protectionRecords.set(key, { ...record, status: 'stale' })
      clearPendingHandshakes(record.tabId)
      changed = true
    }
  }
  if (changed) {
    persistProtectionRecords()
    void recordDiagnosticEvent('protection.permission.changed').catch(() => {})
  }
}

chrome.permissions?.onRemoved.addListener(() => {
  void protectionRestore.then(() => updatePermissionState(false))
})
chrome.permissions?.onAdded.addListener(() => {
  void protectionRestore.then(() => updatePermissionState(true))
})
chrome.tabs?.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return
  void protectionRestore.then(() => {
    clearPendingHandshakes(tabId)
    clearBridgeContexts(tabId)
    for (const [key, record] of protectionRecords) {
      if (record.tabId === tabId) protectionRecords.set(key, { ...record, status: 'stale' })
    }
    persistProtectionRecords()
  })
  invalidatePendingRequestsForTab(tabId)
})
chrome.tabs?.onRemoved.addListener((tabId) => {
  void protectionRestore.then(() => {
    clearPendingHandshakes(tabId)
    clearBridgeContexts(tabId)
    for (const [key, record] of protectionRecords) {
      if (record.tabId === tabId) protectionRecords.delete(key)
    }
    persistProtectionRecords()
  })
  invalidatePendingRequestsForTab(tabId)
})

/** Closing the review popup settles the request as a cancellation — the user never saw a decision the request could still honor. */
chrome.windows.onRemoved?.addListener((windowId) => {
  void pendingRequestsRestore.then(() => {
    for (const [requestId, entry] of pendingSignRequests) {
      if (entry.record.windowId === windowId && !isTerminal(entry.record.state)) {
        settlePendingRequest(requestId, 'cancel')
      }
    }
  })
})
