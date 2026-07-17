import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_TIMEOUT_MS, pendingDecisions, requestDecision } from './background'

describe('requestDecision in background service worker', () => {
  const originalChrome = globalThis.chrome

  beforeEach(() => {
    vi.useFakeTimers()
    vi.restoreAllMocks()
    pendingDecisions.clear()

    globalThis.chrome = {
      runtime: {
        getURL: vi.fn((path: string) => `chrome-extension://id/${path}`),
      },
      windows: {
        create: vi.fn().mockResolvedValue({ id: 101 }),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as typeof chrome
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.chrome = originalChrome
  })

  it('creates popup window with expiresAt parameter and registers pending decision', async () => {
    const promise = requestDecision('req-123', { destination: 'GDEST', score: 75 })
    expect(pendingDecisions.has('req-123')).toBe(true)

    expect(chrome.windows.create).toHaveBeenCalledWith({
      url: expect.stringContaining('mode=intercept&requestId=req-123&destination=GDEST&score=75&expiresAt='),
      type: 'popup',
      width: 320,
      height: 420,
    })

    const resolve = pendingDecisions.get('req-123')
    resolve?.('proceed')
    await expect(promise).resolves.toBe('proceed')
  })

  it('times out after default timeout, resolves to cancel, and closes popup window', async () => {
    const promise = requestDecision('req-123', { destination: 'GDEST', score: 75 })

    // Allow chrome.windows.create resolution to set windowId and advance timer past timeout
    await vi.runAllTimersAsync()

    await expect(promise).resolves.toBe('cancel')
    expect(chrome.windows.remove).toHaveBeenCalledWith(101)
    expect(pendingDecisions.has('req-123')).toBe(false)
  })

  it('times out after custom timeout when provided', async () => {
    const customTimeout = 5000
    const promise = requestDecision('req-456', { destination: 'GDEST', score: 40 }, customTimeout)

    await vi.advanceTimersByTimeAsync(3000)
    expect(pendingDecisions.has('req-456')).toBe(true)

    await vi.advanceTimersByTimeAsync(2500)
    await expect(promise).resolves.toBe('cancel')
    expect(chrome.windows.remove).toHaveBeenCalledWith(101)
  })

  it('clears timer and resolves with user decision when DECISION_MADE arrives before timeout', async () => {
    const promise = requestDecision('req-789', { destination: 'GDEST', score: 10 })

    const resolve = pendingDecisions.get('req-789')
    resolve?.('proceed')

    await expect(promise).resolves.toBe('proceed')
    expect(pendingDecisions.has('req-789')).toBe(false)

    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS + 1000)

    expect(chrome.windows.remove).not.toHaveBeenCalled()
  })
})
