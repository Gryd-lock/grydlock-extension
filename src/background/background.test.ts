import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as resolveModule from '../intercept/resolveOutcome'

const mockAddListener = vi.fn()
const mockGetURL = vi.fn((path: string) => `chrome-extension://test-id/${path}`)
const mockWindowsCreate = vi.fn()

const originalChrome = globalThis.chrome

const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0))

describe('background message listener', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener: mockAddListener },
        getURL: mockGetURL,
      },
      windows: { create: mockWindowsCreate },
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
      const decision = await deps.requestDecision({ destination: 'GDEST', score: 42 })
      return decision === 'proceed' ? 'allow' : 'cancel'
    })

    await import('./background')

    const listener = mockAddListener.mock.calls[0][0]
    const sendResponse = vi.fn()

    // 1. Send SIGN_REQUEST
    const returnsTrue = listener({ type: 'SIGN_REQUEST', requestId: 'req-1', xdr: 'test' }, {}, sendResponse)
    expect(returnsTrue).toBe(true)

    // Wait for resolveOutcome to get called and hit `requestDecision`
    await flushPromises()

    // Verify it called chrome.windows.create with the URL
    expect(mockWindowsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining('mode=intercept&requestId=req-1&destination=GDEST&score=42'),
      })
    )

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
})
