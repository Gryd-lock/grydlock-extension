import { describe, expect, it, vi } from 'vitest'
import { requestOutcome } from './requestOutcome'
import { PAGE_DEADLINE_MS, SIGN_PROTOCOL_VERSION, WINDOW_REQUEST_TYPE } from './protocol'

interface CapturedRequest {
  type: string
  protocolVersion: number
  localId: string
  xdr: string
  networkPassphrase?: string
  adapter: string
}

function captureRequest(): Promise<CapturedRequest> {
  return new Promise((resolve) => {
    function onMessage(event: MessageEvent) {
      const data = event.data as Partial<CapturedRequest> | undefined
      if (data?.type !== WINDOW_REQUEST_TYPE) return
      window.removeEventListener('message', onMessage)
      resolve(data as CapturedRequest)
    }
    window.addEventListener('message', onMessage)
  })
}

/**
 * jsdom does not set `event.source` for a same-window postMessage (it comes
 * through as something other than `window`), so requestOutcome's own
 * `event.source !== window` guard — a deliberate, load-bearing check that
 * rejects responses from other frames/windows — can never be satisfied here.
 * That makes the request/response round trip untestable in this
 * environment; it's the same reason mainWorldEntry.ts/bridgeEntry.ts have
 * never had direct unit tests and are excluded from the coverage gate (see
 * vite.config.ts). The round trip, including the source check, is covered
 * by e2e/signTransaction.spec.ts against a real Chromium instance instead.
 * What jsdom *can* verify: the outgoing request's shape, and the page-side
 * deadline, which settles via a timer rather than a message.
 */
describe('requestOutcome', () => {
  it('posts a versioned, adapter-tagged window request carrying a fresh correlation id', async () => {
    const captured = captureRequest()
    void requestOutcome('xdr-payload', 'Test SDF Network ; September 2015', 'freighter')
    const posted = await captured

    expect(posted.type).toBe(WINDOW_REQUEST_TYPE)
    expect(posted.protocolVersion).toBe(SIGN_PROTOCOL_VERSION)
    expect(posted.xdr).toBe('xdr-payload')
    expect(posted.networkPassphrase).toBe('Test SDF Network ; September 2015')
    expect(posted.adapter).toBe('freighter')
    expect(typeof posted.localId).toBe('string')
    expect(posted.localId.length).toBeGreaterThan(0)
  })

  it('tags the outgoing request with the caller-supplied adapter and omits an absent network passphrase', async () => {
    const captured = captureRequest()
    void requestOutcome('xdr-payload', undefined, 'albedo-popup')
    const posted = await captured

    expect(posted.adapter).toBe('albedo-popup')
    expect(posted.networkPassphrase).toBeUndefined()
  })

  it('two concurrent calls get two distinct, unguessable correlation ids', async () => {
    const first = captureRequest()
    void requestOutcome('xdr-a', undefined, 'freighter')
    const postedFirst = await first

    const second = captureRequest()
    void requestOutcome('xdr-b', undefined, 'freighter')
    const postedSecond = await second

    expect(postedFirst.localId).not.toBe(postedSecond.localId)
  })

  it('resolves cancel once the page-side absolute deadline elapses without any response — the bridge/background may be gone entirely', async () => {
    vi.useFakeTimers()
    try {
      const promise = requestOutcome('xdr-payload', undefined, 'freighter')
      await vi.advanceTimersByTimeAsync(PAGE_DEADLINE_MS)
      await expect(promise).resolves.toBe('cancel')
    } finally {
      vi.useRealTimers()
    }
  })
})
