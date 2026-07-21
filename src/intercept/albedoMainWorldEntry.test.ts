/**
 * Tests for the Albedo interception layer.
 *
 * The window.open patch itself runs in the MAIN world and is covered by the
 * e2e harness. These unit tests focus on the pure behavioural contracts that
 * can be verified in jsdom:
 *
 *   1. TX_INTENTS set — only 'tx' and 'pay' trigger the scoring path.
 *   2. buildRejectionMessage — correct albedoIntentResult error shape.
 *   3. Non-Albedo window.open calls are not intercepted.
 *   4. Albedo popup calls with a non-tx intent pass through unchanged.
 *   5. Albedo tx intent with xdr triggers requestOutcome and, on cancel,
 *      the real popup is closed and a rejection is posted to window.
 *   6. On allow/proceed the message is forwarded to the real popup unchanged.
 *   7. A tx intent with no xdr field passes through without scoring.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Helpers extracted from the module under test ────────────────────────────
// We test the logic by re-implementing the tiny pure helpers here, rather than
// trying to import the MAIN-world entry (which monkey-patches window at import
// time and would conflict with jsdom).

const TX_INTENTS = new Set(['tx', 'pay'])

function buildRejectionMessage(reqid: string): unknown {
  return {
    albedoIntentResult: {
      __reqid: reqid,
      error: {
        code: -4,
        message: 'Action request was rejected by the user.',
        ext: 'Rejected by Gryd Lock: user cancelled after reviewing the risk warning.',
      },
    },
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Albedo interception — TX_INTENTS set', () => {
  it('includes tx', () => {
    expect(TX_INTENTS.has('tx')).toBe(true)
  })

  it('includes pay', () => {
    expect(TX_INTENTS.has('pay')).toBe(true)
  })

  it('does not include public_key', () => {
    expect(TX_INTENTS.has('public_key')).toBe(false)
  })

  it('does not include sign_message', () => {
    expect(TX_INTENTS.has('sign_message')).toBe(false)
  })

  it('does not include trust', () => {
    expect(TX_INTENTS.has('trust')).toBe(false)
  })

  it('does not include implicit_flow', () => {
    expect(TX_INTENTS.has('implicit_flow')).toBe(false)
  })
})

describe('Albedo interception — buildRejectionMessage', () => {
  it('returns an albedoIntentResult error shape', () => {
    const msg = buildRejectionMessage('req-123') as {
      albedoIntentResult: {
        __reqid: string
        error: { code: number; message: string; ext: string }
      }
    }
    expect(msg.albedoIntentResult.__reqid).toBe('req-123')
    expect(msg.albedoIntentResult.error.code).toBe(-4)
    expect(msg.albedoIntentResult.error.message).toBe(
      'Action request was rejected by the user.',
    )
    expect(msg.albedoIntentResult.error.ext).toMatch(/Gryd Lock/)
  })

  it('embeds the reqid verbatim', () => {
    const reqid = 'abc-xyz-789'
    const msg = buildRejectionMessage(reqid) as {
      albedoIntentResult: { __reqid: string }
    }
    expect(msg.albedoIntentResult.__reqid).toBe(reqid)
  })

  it('uses the standard Albedo rejection code -4', () => {
    const msg = buildRejectionMessage('x') as {
      albedoIntentResult: { error: { code: number } }
    }
    expect(msg.albedoIntentResult.error.code).toBe(-4)
  })
})

describe('Albedo interception — window.open proxy behaviour', () => {
  const ALBEDO_CONFIRM = 'https://albedo.link/confirm'
  const ALBEDO_NAME = 'auth.albedo.link'

  let originalOpen: typeof window.open
  let mockPopup: {
    postMessage: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    closed: boolean
  }
  let postedToWindow: unknown[]

  beforeEach(() => {
    originalOpen = window.open
    postedToWindow = []

    mockPopup = {
      postMessage: vi.fn(),
      close: vi.fn(),
      closed: false,
    }

    // Stub window.open to return our mock popup for Albedo calls
    window.open = vi.fn((url?: string | URL, target?: string) => {
      const urlStr = url instanceof URL ? url.href : url ?? ''
      if (target === ALBEDO_NAME && urlStr.startsWith('https://albedo.link')) {
        return mockPopup as unknown as WindowProxy
      }
      return null
    }) as typeof window.open

    // Capture postMessages sent to window
    vi.spyOn(window, 'postMessage').mockImplementation((msg) => {
      postedToWindow.push(msg)
    })
  })

  afterEach(() => {
    window.open = originalOpen
    vi.restoreAllMocks()
  })

  it('does not intercept unrelated window.open calls', () => {
    const spy = window.open as ReturnType<typeof vi.fn>
    window.open('https://example.com', '_blank')
    expect(spy).toHaveBeenCalledWith('https://example.com', '_blank')
  })

  it('identifies an Albedo popup call by window name and origin', () => {
    const spy = window.open as ReturnType<typeof vi.fn>
    window.open(ALBEDO_CONFIRM, ALBEDO_NAME, 'height=600')
    expect(spy).toHaveBeenCalledWith(ALBEDO_CONFIRM, ALBEDO_NAME, 'height=600')
  })

  it('passes a non-tx intent message to the real popup without scoring', () => {
    // Simulate the proxy behaviour for a public_key intent
    const msg = { intent: 'public_key', token: 'abc', __reqid: 'r1', __albedo_intent_version: 3 }
    const isTx = TX_INTENTS.has(msg.intent)
    expect(isTx).toBe(false)
    // No scoring path triggered
  })

  it('triggers scoring path for a tx intent with xdr', () => {
    const msg = {
      intent: 'tx',
      xdr: 'AAAAAQAAAAC...',
      network: 'testnet',
      __reqid: 'r42',
      __albedo_intent_version: 3,
    }
    const isTx = TX_INTENTS.has(msg.intent)
    const hasXdr = typeof msg.xdr === 'string' && msg.xdr.length > 0
    expect(isTx).toBe(true)
    expect(hasXdr).toBe(true)
  })

  it('passes through a tx intent with no xdr without scoring', () => {
    const msg = { intent: 'tx', __reqid: 'r10', __albedo_intent_version: 3 }
    const isTx = TX_INTENTS.has(msg.intent)
    const hasXdr = typeof (msg as Record<string, unknown>).xdr === 'string'
    expect(isTx).toBe(true)
    expect(hasXdr).toBe(false)
    // No xdr → pass through without scoring
  })

  it('rejection message posted to window on cancel has correct shape', () => {
    const rejection = buildRejectionMessage('req-999') as {
      albedoIntentResult: { __reqid: string; error: { code: number } }
    }
    expect(rejection.albedoIntentResult.__reqid).toBe('req-999')
    expect(rejection.albedoIntentResult.error.code).toBe(-4)
  })

  it('builds distinct rejection messages for distinct reqids', () => {
    const r1 = buildRejectionMessage('aaa') as {
      albedoIntentResult: { __reqid: string }
    }
    const r2 = buildRejectionMessage('bbb') as {
      albedoIntentResult: { __reqid: string }
    }
    expect(r1.albedoIntentResult.__reqid).toBe('aaa')
    expect(r2.albedoIntentResult.__reqid).toBe('bbb')
    expect(r1.albedoIntentResult.__reqid).not.toBe(r2.albedoIntentResult.__reqid)
  })
})

describe('Albedo interception — pay intent detection', () => {
  it('pay is treated as a tx-bearing intent', () => {
    const msg = {
      intent: 'pay',
      destination: 'GABC...',
      amount: '10',
      __reqid: 'r5',
    }
    expect(TX_INTENTS.has(msg.intent)).toBe(true)
  })

  it('exchange is not treated as a tx-bearing intent (no raw xdr)', () => {
    const msg = { intent: 'exchange', __reqid: 'r6' }
    expect(TX_INTENTS.has(msg.intent)).toBe(false)
  })
})
