import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as resolveModule from '../intercept/resolveOutcome'
import {
  MAX_NETWORK_PASSPHRASE_LENGTH,
  MAX_REQUEST_ID_LENGTH,
  MAX_XDR_LENGTH,
} from './messageValidation'

const mockAddListener = vi.fn()
const mockGetURL = vi.fn((path: string) => `chrome-extension://test-id/${path}`)
const mockWindowsCreate = vi.fn()
const mockSetBadgeText = vi.fn()
const mockSetBadgeBackgroundColor = vi.fn()

const originalChrome = globalThis.chrome

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('background message listener', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener: mockAddListener },
        getURL: mockGetURL,
      },
      windows: { create: mockWindowsCreate },
      action: {
        setBadgeText: mockSetBadgeText,
        setBadgeBackgroundColor: mockSetBadgeBackgroundColor,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
  })

  afterEach(() => {
    globalThis.chrome = originalChrome
    vi.resetModules() // clear the internal pendingDecisions map for the next test
  })

  it('handles SIGN_REQUEST to SIGN_OUTCOME round trip and explicitly tests pendingDecisions lifecycle', async () => {
    // Intercept resolveOutcome to control when it finishes and observe requestDecision
    vi.spyOn(resolveModule, 'resolveOutcome').mockImplementation(async (_xdr, deps) => {
      // We must await it to test the round trip!
      const decision = await deps.requestDecision({
        destinations: [{ destination: 'GDEST' }],
        scores: [{ destination: 'GDEST', score: 42 }],
        worstScore: 42,
      })
      return decision === 'proceed' ? 'allow' : 'cancel'
    })

    await import('./background')

    const listener = mockAddListener.mock.calls[0][0]
    const sendResponse = vi.fn()

    // 1. Send SIGN_REQUEST
    const returnsTrue = listener(
      { type: 'SIGN_REQUEST', requestId: 'req-1', xdr: 'test' },
      {},
      sendResponse,
    )
    expect(returnsTrue).toBe(true)

    // Wait for resolveOutcome to get called and hit `requestDecision`
    await flushPromises()

    // Verify it called chrome.windows.create with the URL
    const popupUrl = mockWindowsCreate.mock.calls[0][0].url as string
    expect(popupUrl).toContain('mode=intercept')
    expect(popupUrl).toContain('requestId=req-1')
    expect(popupUrl).toContain('destination=GDEST')
    expect(popupUrl).toContain('score=42')

    // Verify badge was set to '!' and color matching score 42 (elevated -> '#a86300')
    expect(mockSetBadgeText).toHaveBeenCalledWith({ text: '!' })
    expect(mockSetBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#a86300' })

    // At this point, pendingDecisions has 'req-1'.
    // We send a DECISION_MADE message to resolve it.
    listener({ type: 'DECISION_MADE', requestId: 'req-1', decision: 'proceed' }, {}, vi.fn())

    // Wait for the Promise chain to resolve
    await flushPromises()

    // Verify round trip completion
    expect(sendResponse).toHaveBeenCalledWith({
      type: 'SIGN_OUTCOME',
      requestId: 'req-1',
      outcome: 'allow',
    })

    // Verify badge text cleared when pending decisions are resolved
    expect(mockSetBadgeText).toHaveBeenCalledWith({ text: '' })

    // Verify delete: sending another DECISION_MADE shouldn't crash or re-resolve anything
    // If pendingDecisions was not deleted, it would try to resolve a completed promise (which is safe in JS, but we want to ensure no crash)
    expect(() => {
      listener({ type: 'DECISION_MADE', requestId: 'req-1', decision: 'cancel' }, {}, vi.fn())
    }).not.toThrow()
  })

  it('safely handles unknown/out-of-order DECISION_MADE messages', async () => {
    await import('./background')
    const listener = mockAddListener.mock.calls[0][0]

    // Send DECISION_MADE without any pending SIGN_REQUEST
    // It should silently no-op at `resolve?.(...)`
    expect(() => {
      listener({ type: 'DECISION_MADE', requestId: 'unknown-id', decision: 'proceed' }, {}, vi.fn())
    }).not.toThrow()
  })

  it('rejects malformed and oversized sign requests before any side effect', async () => {
    const resolveOutcome = vi.spyOn(resolveModule, 'resolveOutcome')
    const { pendingDecisions } = await import('./background')
    const listener = mockAddListener.mock.calls[0][0]
    const sendResponse = vi.fn()
    const invalidMessages: unknown[] = [
      null,
      'SIGN_REQUEST',
      { type: 'SIGN_REQUEST' },
      { type: 'SIGN_REQUEST', requestId: 'req-1' },
      { type: 'SIGN_REQUEST', requestId: 1, xdr: 'AAAAAg==' },
      { type: 'SIGN_REQUEST', requestId: 'req-1', xdr: 1 },
      {
        type: 'SIGN_REQUEST',
        requestId: 'req-1',
        xdr: 'AAAAAg==',
        networkPassphrase: 1,
      },
      {
        type: 'SIGN_REQUEST',
        requestId: 'r'.repeat(MAX_REQUEST_ID_LENGTH + 1),
        xdr: 'AAAAAg==',
      },
      {
        type: 'SIGN_REQUEST',
        requestId: 'req-1',
        xdr: 'A'.repeat(MAX_XDR_LENGTH + 1),
      },
      {
        type: 'SIGN_REQUEST',
        requestId: 'req-1',
        xdr: 'AAAAAg==',
        networkPassphrase: 'n'.repeat(MAX_NETWORK_PASSPHRASE_LENGTH + 1),
      },
    ]

    for (const message of invalidMessages) {
      expect(listener(message, {}, sendResponse)).toBeUndefined()
    }

    expect(resolveOutcome).not.toHaveBeenCalled()
    expect(mockWindowsCreate).not.toHaveBeenCalled()
    expect(mockSetBadgeText).not.toHaveBeenCalled()
    expect(mockSetBadgeBackgroundColor).not.toHaveBeenCalled()
    expect(sendResponse).not.toHaveBeenCalled()
    expect(pendingDecisions.size).toBe(0)
  })

  it('never resolves pending state for an invalid decision message', async () => {
    const { pendingDecisions } = await import('./background')
    const listener = mockAddListener.mock.calls[0][0]
    const resolvePending = vi.fn()
    pendingDecisions.set('req-1', resolvePending)

    const invalidDecisions: unknown[] = [
      { type: 'DECISION_MADE', requestId: 'req-1' },
      { type: 'DECISION_MADE', requestId: 'req-1', decision: 'allow' },
      { type: 'DECISION_MADE', requestId: 'req-1', decision: 1 },
      { type: 'DECISION_MADE', requestId: 1, decision: 'proceed' },
      {
        type: 'DECISION_MADE',
        requestId: 'r'.repeat(MAX_REQUEST_ID_LENGTH + 1),
        decision: 'cancel',
      },
    ]

    for (const message of invalidDecisions) {
      expect(listener(message, {}, vi.fn())).toBeUndefined()
    }

    expect(resolvePending).not.toHaveBeenCalled()
    expect(pendingDecisions.has('req-1')).toBe(true)

    listener({ type: 'DECISION_MADE', requestId: 'req-1', decision: 'cancel' }, {}, vi.fn())
    expect(resolvePending).toHaveBeenCalledOnce()
    expect(resolvePending).toHaveBeenCalledWith('cancel')
  })
})
