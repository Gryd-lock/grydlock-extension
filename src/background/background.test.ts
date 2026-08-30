import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_NETWORK_PASSPHRASE_LENGTH, MAX_XDR_LENGTH } from './messageValidation'
import { MAX_PENDING_PER_FRAME } from '../signing/pendingRequestState'
import type { AggregatedReview } from '../review/model'

const mockAddListener = vi.fn()
const mockGetURL = vi.fn((path: string) => `chrome-extension://test-id/${path}`)
const mockWindowsCreate = vi.fn()
const mockWindowsRemoved = vi.fn()
const mockSetBadgeText = vi.fn()
const mockSetBadgeBackgroundColor = vi.fn()
const mockLocalGet = vi.fn()
const mockLocalSet = vi.fn()
const mockLocalRemove = vi.fn()
const mockSessionGet = vi.fn()
const mockSessionSet = vi.fn()
const mockPermissionContains = vi.fn()
const mockPermissionRemoved = vi.fn()
const mockPermissionAdded = vi.fn()
const mockTabUpdated = vi.fn()
const mockTabRemoved = vi.fn()

const originalChrome = globalThis.chrome

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0))

const FAKE_REVIEW: AggregatedReview = {
  review: {
    schemaVersion: 1,
    policyVersion: 1,
    networkPassphrase: 'test',
    xdrDigest: 'digest-abc',
    envelope: { type: 'transaction', source: 'GDEST', operationCount: 1 },
    operations: [],
    findings: [],
  },
  evidence: [],
  findings: [],
  severity: 'warning',
}

const DAPP_SENDER = {
  tab: { id: 9, url: 'https://dapp.example/' },
  frameId: 0,
  url: 'https://dapp.example/',
}

function popupSender(windowId: number, popupTabId = 200) {
  return {
    tab: { id: popupTabId, windowId, url: 'chrome-extension://test-id/src/popup/index.html' },
    frameId: 0,
    url: 'chrome-extension://test-id/src/popup/index.html',
  }
}

const SIGN_REQUEST_MESSAGE = {
  type: 'SIGN_REQUEST',
  protocolVersion: 1,
  xdr: 'test',
  adapter: 'freighter',
} as const

describe('background message listener', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    mockLocalGet.mockResolvedValue({})
    mockLocalSet.mockResolvedValue(undefined)
    mockLocalRemove.mockResolvedValue(undefined)
    mockSessionGet.mockResolvedValue({})
    mockSessionSet.mockResolvedValue(undefined)
    mockPermissionContains.mockResolvedValue(true)
    mockWindowsCreate.mockImplementation(
      (_options: unknown, callback: (window: { id: number }) => void) => callback({ id: 100 }),
    )
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener: mockAddListener },
        getURL: mockGetURL,
      },
      windows: {
        create: mockWindowsCreate,
        onRemoved: { addListener: mockWindowsRemoved },
      },
      action: {
        setBadgeText: mockSetBadgeText,
        setBadgeBackgroundColor: mockSetBadgeBackgroundColor,
      },
      storage: {
        local: { get: mockLocalGet, set: mockLocalSet, remove: mockLocalRemove },
        session: { get: mockSessionGet, set: mockSessionSet },
      },
      permissions: {
        contains: mockPermissionContains,
        onRemoved: { addListener: mockPermissionRemoved },
        onAdded: { addListener: mockPermissionAdded },
      },
      tabs: {
        onUpdated: { addListener: mockTabUpdated },
        onRemoved: { addListener: mockTabRemoved },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
  })

  afterEach(() => {
    globalThis.chrome = originalChrome
    vi.resetModules() // clear the internal pendingSignRequests map for the next test
  })

  // resolveOutcome must be imported dynamically (not via a static top-level
  // import) because vi.resetModules() in afterEach clears the module
  // registry: a stale static reference would spy on a module instance
  // background.ts's own re-import no longer resolves to, silently falling
  // through to the REAL buildAggregatedReview (which fails closed on the
  // fixture's non-XDR 'test' string) for every test after the first.
  async function importBackgroundWithFakeReview(review: AggregatedReview | null = FAKE_REVIEW) {
    const resolveModule = await import('../intercept/resolveOutcome')
    vi.spyOn(resolveModule, 'buildAggregatedReview').mockResolvedValue(review)
    await import('./background')
    return mockAddListener.mock.calls[0][0]
  }

  it('handles the full SIGN_REQUEST -> SIGN_ACK -> AWAIT_OUTCOME -> DECISION_MADE -> SIGN_OUTCOME round trip', async () => {
    const listener = await importBackgroundWithFakeReview()

    const signResponse = vi.fn()
    expect(listener(SIGN_REQUEST_MESSAGE, DAPP_SENDER, signResponse)).toBe(true)
    await flushPromises()
    await flushPromises()

    expect(signResponse).toHaveBeenCalledTimes(1)
    const ack = signResponse.mock.calls[0][0]
    expect(ack.type).toBe('SIGN_ACK')
    expect(typeof ack.requestId).toBe('string')
    expect(ack.requestId.length).toBeGreaterThan(0)
    expect(typeof ack.deadlineAt).toBe('number')

    const popupUrl = mockWindowsCreate.mock.calls[0][0].url as string
    expect(popupUrl).toContain('mode=intercept')
    expect(popupUrl).toContain(`requestId=${ack.requestId}`)
    expect(mockSetBadgeText).toHaveBeenCalledWith({ text: '!' })

    const awaitResponse = vi.fn()
    expect(
      listener({ type: 'AWAIT_OUTCOME', requestId: ack.requestId }, {}, awaitResponse),
    ).toBe(true)
    await flushPromises()
    expect(awaitResponse).not.toHaveBeenCalled() // still awaiting_review: the port stays open

    const decisionSender = popupSender(100)
    listener(
      { type: 'DECISION_MADE', protocolVersion: 1, requestId: ack.requestId, decision: 'proceed' },
      decisionSender,
      vi.fn(),
    )
    await flushPromises()

    expect(awaitResponse).toHaveBeenCalledWith({
      type: 'SIGN_OUTCOME',
      requestId: ack.requestId,
      outcome: 'proceed',
    })
    expect(mockSetBadgeText).toHaveBeenCalledWith({ text: '' })

    // A replayed AWAIT_OUTCOME after settlement resolves immediately from the tombstone.
    const replayAwait = vi.fn()
    listener({ type: 'AWAIT_OUTCOME', requestId: ack.requestId }, {}, replayAwait)
    await flushPromises()
    expect(replayAwait).toHaveBeenCalledWith({
      type: 'SIGN_OUTCOME',
      requestId: ack.requestId,
      outcome: 'proceed',
    })

    // A replayed DECISION_MADE (e.g. a double-submit) is a no-op: it must not crash and must
    // not re-fire diagnostics/badge logic for an already-settled request.
    expect(() =>
      listener(
        { type: 'DECISION_MADE', protocolVersion: 1, requestId: ack.requestId, decision: 'cancel' },
        decisionSender,
        vi.fn(),
      ),
    ).not.toThrow()
    await flushPromises()
    const replayAwait2 = vi.fn()
    listener({ type: 'AWAIT_OUTCOME', requestId: ack.requestId }, {}, replayAwait2)
    await flushPromises()
    // Still 'proceed' — the replayed cancel never overwrote the first terminal decision.
    expect(replayAwait2).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'proceed' }),
    )
  })

  it('never trusts a page-supplied requestId: two concurrent SIGN_REQUESTs get two distinct, extension-generated ids', async () => {
    const listener = await importBackgroundWithFakeReview()

    const responseA = vi.fn()
    const responseB = vi.fn()
    listener(SIGN_REQUEST_MESSAGE, { ...DAPP_SENDER, frameId: 0 }, responseA)
    await flushPromises()
    listener(SIGN_REQUEST_MESSAGE, { ...DAPP_SENDER, frameId: 1 }, responseB)
    await flushPromises()
    await flushPromises()

    const idA = responseA.mock.calls[0][0].requestId
    const idB = responseB.mock.calls[0][0].requestId
    expect(idA).not.toBe(idB)
    expect(idA).not.toBe('page-supplied-id')
  })

  it('rejects a SIGN_REQUEST carrying an unrecognized field (e.g. a page-supplied requestId) as malformed', async () => {
    const listener = await importBackgroundWithFakeReview()
    const sendResponse = vi.fn()
    expect(
      listener({ ...SIGN_REQUEST_MESSAGE, requestId: 'attacker-chosen' }, DAPP_SENDER, sendResponse),
    ).toBeUndefined()
    expect(sendResponse).not.toHaveBeenCalled()
    expect(mockWindowsCreate).not.toHaveBeenCalled()
  })

  it('responds SIGN_REJECTED for a mismatched protocol version without any side effect', async () => {
    const listener = await importBackgroundWithFakeReview()
    const sendResponse = vi.fn()
    expect(
      listener({ ...SIGN_REQUEST_MESSAGE, protocolVersion: 2 }, DAPP_SENDER, sendResponse),
    ).toBe(true)
    await flushPromises()
    expect(sendResponse).toHaveBeenCalledWith({ type: 'SIGN_REJECTED', reason: 'protocol-incompatible' })
    expect(mockWindowsCreate).not.toHaveBeenCalled()
  })

  it('responds SIGN_REJECTED sender-unbound when the sender has no bindable tab', async () => {
    const listener = await importBackgroundWithFakeReview()
    const sendResponse = vi.fn()
    expect(listener(SIGN_REQUEST_MESSAGE, {}, sendResponse)).toBe(true)
    await flushPromises()
    expect(sendResponse).toHaveBeenCalledWith({ type: 'SIGN_REJECTED', reason: 'sender-unbound' })
    expect(mockWindowsCreate).not.toHaveBeenCalled()
  })

  it('admits a request even when sender.documentId is absent (older-Chrome compatibility fallback)', async () => {
    const listener = await importBackgroundWithFakeReview()
    const sendResponse = vi.fn()
    listener(SIGN_REQUEST_MESSAGE, DAPP_SENDER, sendResponse)
    await flushPromises()
    await flushPromises()
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SIGN_ACK' }),
    )
    expect(mockWindowsCreate).toHaveBeenCalledTimes(1)
  })

  it('rejects the (MAX_PENDING_PER_FRAME + 1)th concurrent request from the same frame without opening a window', async () => {
    const listener = await importBackgroundWithFakeReview()

    for (let index = 0; index < MAX_PENDING_PER_FRAME; index += 1) {
      const sendResponse = vi.fn()
      listener(SIGN_REQUEST_MESSAGE, DAPP_SENDER, sendResponse)
      await flushPromises()
      await flushPromises()
      expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ type: 'SIGN_ACK' }))
    }
    expect(mockWindowsCreate).toHaveBeenCalledTimes(MAX_PENDING_PER_FRAME)

    const overflowResponse = vi.fn()
    listener(SIGN_REQUEST_MESSAGE, DAPP_SENDER, overflowResponse)
    await flushPromises()
    expect(overflowResponse).toHaveBeenCalledWith({ type: 'SIGN_REJECTED', reason: 'frame-limit' })
    expect(mockWindowsCreate).toHaveBeenCalledTimes(MAX_PENDING_PER_FRAME)
  })

  it('a decision from the wrong popup window is rejected; the request stays open for the correct one', async () => {
    const listener = await importBackgroundWithFakeReview()
    const sendResponse = vi.fn()
    listener(SIGN_REQUEST_MESSAGE, DAPP_SENDER, sendResponse)
    await flushPromises()
    await flushPromises()
    const requestId = sendResponse.mock.calls[0][0].requestId

    // The first legitimate contact binds the review window (TOFU) — establish it.
    const getReview = vi.fn()
    listener(
      { type: 'GET_REVIEW', protocolVersion: 1, requestId },
      popupSender(100),
      getReview,
    )
    await flushPromises()
    expect(getReview).toHaveBeenCalledWith(
      expect.objectContaining({ review: expect.objectContaining({ severity: 'warning' }) }),
    )

    // A decision from a different window (e.g. a copied review URL opened elsewhere) is a no-op.
    listener(
      { type: 'DECISION_MADE', protocolVersion: 1, requestId, decision: 'proceed' },
      popupSender(999, 201),
      vi.fn(),
    )
    await flushPromises()

    const awaitResponse = vi.fn()
    listener({ type: 'AWAIT_OUTCOME', requestId }, {}, awaitResponse)
    await flushPromises()
    expect(awaitResponse).not.toHaveBeenCalled() // still pending: the wrong-window decision did not settle it

    // The correct window's decision still works.
    listener(
      { type: 'DECISION_MADE', protocolVersion: 1, requestId, decision: 'cancel' },
      popupSender(100),
      vi.fn(),
    )
    await flushPromises()
    expect(awaitResponse).toHaveBeenCalledWith({ type: 'SIGN_OUTCOME', requestId, outcome: 'cancel' })
  })

  it('a copied review URL opened in the wrong window reveals no review content', async () => {
    const listener = await importBackgroundWithFakeReview()
    const sendResponse = vi.fn()
    listener(SIGN_REQUEST_MESSAGE, DAPP_SENDER, sendResponse)
    await flushPromises()
    await flushPromises()
    const requestId = sendResponse.mock.calls[0][0].requestId

    listener({ type: 'GET_REVIEW', protocolVersion: 1, requestId }, popupSender(100), vi.fn())
    await flushPromises()

    const wrongWindowRead = vi.fn()
    listener(
      { type: 'GET_REVIEW', protocolVersion: 1, requestId },
      popupSender(999, 201),
      wrongWindowRead,
    )
    await flushPromises()
    expect(wrongWindowRead).toHaveBeenCalledWith({ type: 'REVIEW_DATA', requestId })
  })

  it('closing the review popup (windows.onRemoved) settles the request as cancelled', async () => {
    const listener = await importBackgroundWithFakeReview()
    const sendResponse = vi.fn()
    listener(SIGN_REQUEST_MESSAGE, DAPP_SENDER, sendResponse)
    await flushPromises()
    await flushPromises()
    const requestId = sendResponse.mock.calls[0][0].requestId

    const awaitResponse = vi.fn()
    listener({ type: 'AWAIT_OUTCOME', requestId }, {}, awaitResponse)
    await flushPromises()
    expect(awaitResponse).not.toHaveBeenCalled()

    const onWindowRemoved = mockWindowsRemoved.mock.calls[0][0]
    onWindowRemoved(100) // the windowId chrome.windows.create resolved to
    await flushPromises()

    expect(awaitResponse).toHaveBeenCalledWith({ type: 'SIGN_OUTCOME', requestId, outcome: 'cancel' })
  })

  it('a popup creation failure settles the request as failed (outcome cancel) and clears the badge', async () => {
    mockWindowsCreate.mockImplementation((_options: unknown, callback: (w?: undefined) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(globalThis.chrome.runtime as any).lastError = { message: 'popup creation failed' }
      callback(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis.chrome.runtime as any).lastError
    })
    const listener = await importBackgroundWithFakeReview()
    const sendResponse = vi.fn()
    listener(SIGN_REQUEST_MESSAGE, DAPP_SENDER, sendResponse)
    await flushPromises()
    await flushPromises()
    const requestId = sendResponse.mock.calls[0][0].requestId

    const awaitResponse = vi.fn()
    listener({ type: 'AWAIT_OUTCOME', requestId }, {}, awaitResponse)
    await flushPromises()
    expect(awaitResponse).toHaveBeenCalledWith({ type: 'SIGN_OUTCOME', requestId, outcome: 'cancel' })
    expect(mockSetBadgeText).toHaveBeenCalledWith({ text: '' })
  })

  it('originating tab navigation invalidates the pending request', async () => {
    const listener = await importBackgroundWithFakeReview()
    const sendResponse = vi.fn()
    listener(SIGN_REQUEST_MESSAGE, DAPP_SENDER, sendResponse)
    await flushPromises()
    await flushPromises()
    const requestId = sendResponse.mock.calls[0][0].requestId

    const onTabUpdated = mockTabUpdated.mock.calls[0][0]
    onTabUpdated(DAPP_SENDER.tab.id, { status: 'loading' })
    await flushPromises()

    const awaitResponse = vi.fn()
    listener({ type: 'AWAIT_OUTCOME', requestId }, {}, awaitResponse)
    await flushPromises()
    expect(awaitResponse).toHaveBeenCalledWith({ type: 'SIGN_OUTCOME', requestId, outcome: 'cancel' })
  })

  it('originating tab closure invalidates the pending request', async () => {
    const listener = await importBackgroundWithFakeReview()
    const sendResponse = vi.fn()
    listener(SIGN_REQUEST_MESSAGE, DAPP_SENDER, sendResponse)
    await flushPromises()
    await flushPromises()
    const requestId = sendResponse.mock.calls[0][0].requestId

    const onTabRemoved = mockTabRemoved.mock.calls[0][0]
    onTabRemoved(DAPP_SENDER.tab.id)
    await flushPromises()

    const awaitResponse = vi.fn()
    listener({ type: 'AWAIT_OUTCOME', requestId }, {}, awaitResponse)
    await flushPromises()
    expect(awaitResponse).toHaveBeenCalledWith({ type: 'SIGN_OUTCOME', requestId, outcome: 'cancel' })
  })

  it('a malformed/unreviewable XDR settles failed (outcome cancel) instead of hanging', async () => {
    const listener = await importBackgroundWithFakeReview(null)

    const sendResponse = vi.fn()
    listener(SIGN_REQUEST_MESSAGE, DAPP_SENDER, sendResponse)
    await flushPromises()
    await flushPromises()
    const requestId = sendResponse.mock.calls[0][0].requestId

    // No popup is opened for a request that never reaches awaiting_review.
    expect(mockWindowsCreate).not.toHaveBeenCalled()

    const awaitResponse = vi.fn()
    listener({ type: 'AWAIT_OUTCOME', requestId }, {}, awaitResponse)
    await flushPromises()
    expect(awaitResponse).toHaveBeenCalledWith({ type: 'SIGN_OUTCOME', requestId, outcome: 'cancel' })
  })

  it('AWAIT_OUTCOME for an unknown/never-seen requestId fails closed to cancel', async () => {
    const listener = await importBackgroundWithFakeReview()
    const awaitResponse = vi.fn()
    listener({ type: 'AWAIT_OUTCOME', requestId: 'never-existed' }, {}, awaitResponse)
    await flushPromises()
    expect(awaitResponse).toHaveBeenCalledWith({
      type: 'SIGN_OUTCOME',
      requestId: 'never-existed',
      outcome: 'cancel',
    })
  })

  it('resumes a pending request restored from durable storage after a worker restart', async () => {
    const restoredRequestId = 'restored-request-1'
    mockSessionGet.mockImplementation((key: string) => {
      if (key === 'pendingRequestStateV1') {
        return Promise.resolve({
          pendingRequestStateV1: [
            {
              requestId: restoredRequestId,
              adapter: 'freighter',
              tabId: 9,
              frameId: 0,
              documentBound: true,
              state: 'awaiting_review',
              protocolVersion: 1,
              createdAt: Date.now(),
              deadlineAt: Date.now() + 60_000,
              windowId: 100,
            },
          ],
        })
      }
      return Promise.resolve({})
    })

    await import('./background')
    const listener = mockAddListener.mock.calls[0][0]

    // The resolver was lost with the old worker lifetime; AWAIT_OUTCOME re-attaches a fresh one
    // by reading the durable record, and the port stays open until a decision arrives.
    const awaitResponse = vi.fn()
    listener({ type: 'AWAIT_OUTCOME', requestId: restoredRequestId }, {}, awaitResponse)
    await flushPromises()
    expect(awaitResponse).not.toHaveBeenCalled()

    listener(
      {
        type: 'DECISION_MADE',
        protocolVersion: 1,
        requestId: restoredRequestId,
        decision: 'proceed',
      },
      popupSender(100),
      vi.fn(),
    )
    await flushPromises()

    expect(awaitResponse).toHaveBeenCalledWith({
      type: 'SIGN_OUTCOME',
      requestId: restoredRequestId,
      outcome: 'proceed',
    })
  })

  it('a restored request whose deadline already passed settles expired (outcome cancel) immediately, with no dangling resolver', async () => {
    const restoredRequestId = 'restored-expired-1'
    mockSessionGet.mockImplementation((key: string) => {
      if (key === 'pendingRequestStateV1') {
        return Promise.resolve({
          pendingRequestStateV1: [
            {
              requestId: restoredRequestId,
              adapter: 'freighter',
              tabId: 9,
              frameId: 0,
              documentBound: true,
              state: 'awaiting_review',
              protocolVersion: 1,
              createdAt: Date.now() - 200_000,
              deadlineAt: Date.now() - 1,
              windowId: 100,
            },
          ],
        })
      }
      return Promise.resolve({})
    })

    await import('./background')
    const listener = mockAddListener.mock.calls[0][0]

    const awaitResponse = vi.fn()
    listener({ type: 'AWAIT_OUTCOME', requestId: restoredRequestId }, {}, awaitResponse)
    await flushPromises()
    expect(awaitResponse).toHaveBeenCalledWith({
      type: 'SIGN_OUTCOME',
      requestId: restoredRequestId,
      outcome: 'cancel',
    })
  })

  it('rejects malformed and oversized sign requests before any side effect', async () => {
    const resolveModule = await import('../intercept/resolveOutcome')
    const buildReview = vi.spyOn(resolveModule, 'buildAggregatedReview')
    await import('./background')
    const listener = mockAddListener.mock.calls[0][0]
    const sendResponse = vi.fn()
    const invalidMessages: unknown[] = [
      null,
      'SIGN_REQUEST',
      { type: 'SIGN_REQUEST' },
      { type: 'SIGN_REQUEST', protocolVersion: 1 },
      { type: 'SIGN_REQUEST', protocolVersion: 1, xdr: 1, adapter: 'freighter' },
      { type: 'SIGN_REQUEST', protocolVersion: 1, xdr: 'AAAAAg==', adapter: 'metamask' },
      {
        type: 'SIGN_REQUEST',
        protocolVersion: 1,
        xdr: 'AAAAAg==',
        adapter: 'freighter',
        networkPassphrase: 1,
      },
      {
        type: 'SIGN_REQUEST',
        protocolVersion: 1,
        xdr: 'A'.repeat(MAX_XDR_LENGTH + 1),
        adapter: 'freighter',
      },
      {
        type: 'SIGN_REQUEST',
        protocolVersion: 1,
        xdr: 'AAAAAg==',
        adapter: 'freighter',
        networkPassphrase: 'n'.repeat(MAX_NETWORK_PASSPHRASE_LENGTH + 1),
      },
    ]

    for (const message of invalidMessages) {
      expect(listener(message, DAPP_SENDER, sendResponse)).toBeUndefined()
    }

    expect(buildReview).not.toHaveBeenCalled()
    expect(mockWindowsCreate).not.toHaveBeenCalled()
    expect(mockSetBadgeText).not.toHaveBeenCalled()
    expect(mockSetBadgeBackgroundColor).not.toHaveBeenCalled()
    expect(sendResponse).not.toHaveBeenCalled()
  })

  it('never resolves pending state for an invalid decision message', async () => {
    const listener = await importBackgroundWithFakeReview()
    const sendResponse = vi.fn()
    listener(SIGN_REQUEST_MESSAGE, DAPP_SENDER, sendResponse)
    await flushPromises()
    await flushPromises()
    const requestId = sendResponse.mock.calls[0][0].requestId

    const invalidDecisions: unknown[] = [
      { type: 'DECISION_MADE', protocolVersion: 1, requestId },
      { type: 'DECISION_MADE', protocolVersion: 1, requestId, decision: 'allow' },
      { type: 'DECISION_MADE', protocolVersion: 1, requestId, decision: 1 },
      { type: 'DECISION_MADE', protocolVersion: 1, requestId: 1, decision: 'proceed' },
      { type: 'DECISION_MADE', protocolVersion: 2, requestId, decision: 'proceed' },
    ]

    for (const message of invalidDecisions) {
      expect(listener(message, popupSender(100), vi.fn())).toBeUndefined()
    }
    await flushPromises()

    const awaitResponse = vi.fn()
    listener({ type: 'AWAIT_OUTCOME', requestId }, {}, awaitResponse)
    await flushPromises()
    expect(awaitResponse).not.toHaveBeenCalled() // still pending: none of the invalid messages resolved it

    listener(
      { type: 'DECISION_MADE', protocolVersion: 1, requestId, decision: 'cancel' },
      popupSender(100),
      vi.fn(),
    )
    await flushPromises()
    expect(awaitResponse).toHaveBeenCalledWith({ type: 'SIGN_OUTCOME', requestId, outcome: 'cancel' })
  })

  it('requires a fresh successful non-financial handshake before reporting protected', async () => {
    await import('./background')
    const listener = mockAddListener.mock.calls[0][0]
    const sender = {
      tab: { id: 9, url: 'https://wallet.example/' },
      frameId: 0,
      url: 'https://wallet.example/',
    }
    const respondToHandshake = vi.fn()

    expect(
      listener(
        {
          type: 'PROTECTION_HANDSHAKE',
          nonce: 'nonce-1',
          adapter: 'freighter',
          protocolVersion: 1,
        },
        sender,
        respondToHandshake,
      ),
    ).toBe(true)
    await flushPromises()
    expect(respondToHandshake).toHaveBeenCalledWith({ accepted: true })

    listener(
      {
        type: 'PROTECTION_HANDSHAKE_ACK',
        nonce: 'nonce-1',
        adapter: 'freighter',
        protocolVersion: 1,
      },
      sender,
      vi.fn(),
    )
    await flushPromises()
    const respondToStatus = vi.fn()
    listener({ type: 'GET_PROTECTION_STATUS', tabId: 9 }, {}, respondToStatus)
    await flushPromises()
    expect(respondToStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'protected', adapter: 'freighter' }),
    )
  })

  it('fails closed for missing bridges and revoked site access', async () => {
    await import('./background')
    const listener = mockAddListener.mock.calls[0][0]
    const missingBridge = vi.fn()
    listener({ type: 'GET_PROTECTION_STATUS', tabId: 44 }, {}, missingBridge)
    await flushPromises()
    expect(missingBridge).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'bridge-unavailable' }),
    )

    mockPermissionContains.mockResolvedValue(false)
    const denied = vi.fn()
    const sender = {
      tab: { id: 45, url: 'https://denied.example/' },
      frameId: 0,
      url: 'https://denied.example/',
    }
    listener(
      { type: 'PROTECTION_HANDSHAKE', nonce: 'nonce-2', adapter: 'freighter', protocolVersion: 1 },
      sender,
      denied,
    )
    await flushPromises()
    expect(denied).toHaveBeenCalledWith({ accepted: false })
    const status = vi.fn()
    listener({ type: 'GET_PROTECTION_STATUS', tabId: 45 }, {}, status)
    await flushPromises()
    expect(status).toHaveBeenCalledWith(expect.objectContaining({ status: 'permission-denied' }))
  })

  it('distinguishes an injected bridge with no health result from a missing bridge', async () => {
    await import('./background')
    const listener = mockAddListener.mock.calls[0][0]
    const sender = {
      tab: { id: 46, url: 'https://wallet.example/' },
      frameId: 0,
      url: 'https://wallet.example/',
      documentId: 'document-46',
    }
    listener({ type: 'PROTECTION_BRIDGE_ONLINE', protocolVersion: 1 }, sender, vi.fn())
    await flushPromises()

    const status = vi.fn()
    listener({ type: 'GET_PROTECTION_STATUS', tabId: 46 }, {}, status)
    await flushPromises()
    expect(status).toHaveBeenCalledWith(expect.objectContaining({ status: 'unknown' }))
  })

  it('does not accept a handshake acknowledgement from a different document, tab, or frame', async () => {
    await import('./background')
    const listener = mockAddListener.mock.calls[0][0]
    const sender = {
      tab: { id: 51, url: 'https://wallet.example/' },
      frameId: 2,
      url: 'https://wallet.example/',
      documentId: 'document-a',
    }

    listener(
      {
        type: 'PROTECTION_HANDSHAKE',
        nonce: 'nonce-boundary',
        adapter: 'freighter',
        protocolVersion: 1,
      },
      sender,
      vi.fn(),
    )
    await flushPromises()
    listener(
      {
        type: 'PROTECTION_HANDSHAKE_ACK',
        nonce: 'nonce-boundary',
        adapter: 'freighter',
        protocolVersion: 1,
      },
      {
        tab: { id: 51, url: 'https://wallet.example/' },
        frameId: 2,
        url: 'https://wallet.example/',
        documentId: 'document-b',
      },
      vi.fn(),
    )
    await flushPromises()

    const response = vi.fn()
    listener({ type: 'GET_PROTECTION_STATUS', tabId: 51 }, {}, response)
    await flushPromises()
    expect(response).toHaveBeenCalledWith(expect.objectContaining({ status: 'unknown' }))
  })

  it('invalidates only the revoked site and requires a fresh handshake after restoration', async () => {
    await import('./background')
    const listener = mockAddListener.mock.calls[0][0]
    const sender = {
      tab: { id: 52, url: 'https://wallet.example/' },
      frameId: 0,
      url: 'https://wallet.example/',
      documentId: 'document-52',
    }

    listener(
      {
        type: 'PROTECTION_HANDSHAKE',
        nonce: 'permission-nonce',
        adapter: 'freighter',
        protocolVersion: 1,
      },
      sender,
      vi.fn(),
    )
    await flushPromises()
    listener(
      {
        type: 'PROTECTION_HANDSHAKE_ACK',
        nonce: 'permission-nonce',
        adapter: 'freighter',
        protocolVersion: 1,
      },
      sender,
      vi.fn(),
    )
    await flushPromises()

    mockPermissionContains.mockResolvedValue(false)
    mockPermissionRemoved.mock.calls[0][0]({ origins: ['https://wallet.example/*'] })
    await flushPromises()
    const denied = vi.fn()
    listener({ type: 'GET_PROTECTION_STATUS', tabId: 52 }, {}, denied)
    await flushPromises()
    expect(denied).toHaveBeenCalledWith(expect.objectContaining({ status: 'permission-denied' }))

    mockPermissionContains.mockResolvedValue(true)
    mockPermissionAdded.mock.calls[0][0]({ origins: ['https://wallet.example/*'] })
    await flushPromises()
    const restored = vi.fn()
    listener({ type: 'GET_PROTECTION_STATUS', tabId: 52 }, {}, restored)
    await flushPromises()
    expect(restored).toHaveBeenCalledWith(expect.objectContaining({ status: 'stale' }))

    listener(
      {
        type: 'PROTECTION_HANDSHAKE',
        nonce: 'restored-nonce',
        adapter: 'freighter',
        protocolVersion: 1,
      },
      sender,
      vi.fn(),
    )
    await flushPromises()
    listener(
      {
        type: 'PROTECTION_HANDSHAKE_ACK',
        nonce: 'restored-nonce',
        adapter: 'freighter',
        protocolVersion: 1,
      },
      sender,
      vi.fn(),
    )
    await flushPromises()
    const fresh = vi.fn()
    listener({ type: 'GET_PROTECTION_STATUS', tabId: 52 }, {}, fresh)
    await flushPromises()
    expect(fresh).toHaveBeenCalledWith(expect.objectContaining({ status: 'protected' }))
  })

  it('marks restored worker state stale until a new handshake completes', async () => {
    mockSessionGet.mockResolvedValue({
      protectionStateV1: [
        {
          tabId: 54,
          frameId: 0,
          adapter: 'freighter',
          status: 'protected',
          protocolVersion: 1,
          checkedAt: Date.now(),
        },
      ],
    })
    await import('./background')
    const listener = mockAddListener.mock.calls[0][0]
    const status = vi.fn()
    listener({ type: 'GET_PROTECTION_STATUS', tabId: 54 }, {}, status)
    await flushPromises()
    expect(status).toHaveBeenCalledWith(expect.objectContaining({ status: 'stale' }))
  })

  it('keeps a known unsupported adapter non-protective until navigation resets the document', async () => {
    await import('./background')
    const listener = mockAddListener.mock.calls[0][0]
    const sender = {
      tab: { id: 53, url: 'https://wallet.example/' },
      frameId: 0,
      url: 'https://wallet.example/',
    }

    listener(
      {
        type: 'PROTECTION_ADAPTER_STATUS',
        adapter: 'albedo-popup',
        status: 'unsupported',
        protocolVersion: 1,
      },
      sender,
      vi.fn(),
    )
    await flushPromises()
    listener(
      {
        type: 'PROTECTION_HANDSHAKE',
        nonce: 'nonce-unsupported',
        adapter: 'albedo-popup',
        protocolVersion: 1,
      },
      sender,
      vi.fn(),
    )
    await flushPromises()
    listener(
      {
        type: 'PROTECTION_HANDSHAKE_ACK',
        nonce: 'nonce-unsupported',
        adapter: 'albedo-popup',
        protocolVersion: 1,
      },
      sender,
      vi.fn(),
    )
    await flushPromises()

    const response = vi.fn()
    listener({ type: 'GET_PROTECTION_STATUS', tabId: 53 }, {}, response)
    await flushPromises()
    expect(response).toHaveBeenCalledWith(expect.objectContaining({ status: 'unsupported' }))
  })
})
