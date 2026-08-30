import { describe, expect, it } from 'vitest'
import {
  MAX_PENDING_GLOBAL,
  MAX_PENDING_PER_FRAME,
  REVIEW_DEADLINE_MS,
  TOMBSTONE_TTL_MS,
  admissionCheck,
  applyTransition,
  canTransition,
  isExpired,
  isTerminal,
  outcomeForState,
  shouldPrune,
  validatePendingRequestRecord,
  type PendingRequestRecord,
  type PendingState,
} from './pendingRequestState'

const NOW = 1_000_000

function makeRecord(overrides: Partial<PendingRequestRecord> = {}): PendingRequestRecord {
  return {
    requestId: 'req-1',
    adapter: 'freighter',
    tabId: 1,
    frameId: 0,
    documentBound: true,
    state: 'received',
    protocolVersion: 1,
    createdAt: NOW,
    deadlineAt: NOW + REVIEW_DEADLINE_MS,
    ...overrides,
  }
}

describe('canTransition / applyTransition', () => {
  it('allows the full happy path in order', () => {
    const path: PendingState[] = [
      'received',
      'validating',
      'assessing',
      'awaiting_review',
      'proceed',
    ]
    for (let index = 0; index < path.length - 1; index += 1) {
      expect(canTransition(path[index], path[index + 1])).toBe(true)
    }
  })

  it('rejects skipping states', () => {
    expect(canTransition('received', 'awaiting_review')).toBe(false)
    expect(canTransition('received', 'assessing')).toBe(false)
    expect(canTransition('validating', 'awaiting_review')).toBe(false)
  })

  it('rejects any transition out of a terminal state', () => {
    for (const terminal of ['proceed', 'cancel', 'expired', 'failed'] as const) {
      for (const next of ['received', 'validating', 'assessing', 'awaiting_review'] as const) {
        expect(canTransition(terminal, next)).toBe(false)
      }
    }
  })

  it('every state can reach a terminal state directly except the states already terminal', () => {
    for (const state of ['received', 'validating', 'assessing'] as const) {
      expect(canTransition(state, 'failed')).toBe(true)
      expect(canTransition(state, 'expired')).toBe(true)
    }
    expect(canTransition('awaiting_review', 'proceed')).toBe(true)
    expect(canTransition('awaiting_review', 'cancel')).toBe(true)
    expect(canTransition('awaiting_review', 'expired')).toBe(true)
    expect(canTransition('awaiting_review', 'failed')).toBe(true)
  })

  it('applyTransition returns null (no-op) for an invalid transition', () => {
    const record = makeRecord({ state: 'received' })
    expect(applyTransition(record, 'awaiting_review', NOW)).toBeNull()
  })

  it('the first valid terminal transition wins; replaying the SAME terminal state is an idempotent no-op that returns the unchanged record', () => {
    const record = makeRecord({ state: 'awaiting_review' })
    const settled = applyTransition(record, 'proceed', NOW)
    expect(settled?.state).toBe('proceed')
    expect(settled?.settledAt).toBe(NOW)

    const replay = applyTransition(settled as PendingRequestRecord, 'proceed', NOW + 5_000)
    expect(replay).toBe(settled) // same reference: no mutation, no re-settlement
  })

  it('rejects a DIFFERENT terminal transition once already terminal (replay cannot flip proceed to cancel)', () => {
    const record = makeRecord({ state: 'awaiting_review' })
    const settled = applyTransition(record, 'proceed', NOW) as PendingRequestRecord
    expect(applyTransition(settled, 'cancel', NOW + 1)).toBeNull()
  })

  it('merges a patch (e.g. binding the xdrDigest) on a successful transition', () => {
    const record = makeRecord({ state: 'assessing' })
    const updated = applyTransition(record, 'awaiting_review', NOW, { xdrDigest: 'abc123' })
    expect(updated?.xdrDigest).toBe('abc123')
    expect(updated?.state).toBe('awaiting_review')
  })
})

describe('isExpired / isTerminal / outcomeForState', () => {
  it('a non-terminal record past its deadline is expired', () => {
    const record = makeRecord({ state: 'awaiting_review', deadlineAt: NOW - 1 })
    expect(isExpired(record, NOW)).toBe(true)
  })

  it('a terminal record is never "expired" even past its deadline', () => {
    const record = makeRecord({ state: 'proceed', deadlineAt: NOW - 1, settledAt: NOW - 1 })
    expect(isExpired(record, NOW)).toBe(false)
  })

  it('isTerminal is true only for proceed/cancel/expired/failed', () => {
    expect(isTerminal('proceed')).toBe(true)
    expect(isTerminal('cancel')).toBe(true)
    expect(isTerminal('expired')).toBe(true)
    expect(isTerminal('failed')).toBe(true)
    expect(isTerminal('awaiting_review')).toBe(false)
    expect(isTerminal('received')).toBe(false)
  })

  it('outcomeForState maps proceed to proceed and everything else to cancel', () => {
    expect(outcomeForState('proceed')).toBe('proceed')
    expect(outcomeForState('cancel')).toBe('cancel')
    expect(outcomeForState('expired')).toBe('cancel')
    expect(outcomeForState('failed')).toBe('cancel')
  })
})

describe('shouldPrune (tombstone TTL)', () => {
  it('keeps a terminal record before the tombstone TTL elapses', () => {
    const record = makeRecord({ state: 'cancel', settledAt: NOW })
    expect(shouldPrune(record, NOW + TOMBSTONE_TTL_MS - 1)).toBe(false)
  })

  it('prunes a terminal record once the tombstone TTL elapses', () => {
    const record = makeRecord({ state: 'cancel', settledAt: NOW })
    expect(shouldPrune(record, NOW + TOMBSTONE_TTL_MS + 1)).toBe(true)
  })

  it('never prunes a non-terminal record regardless of age', () => {
    const record = makeRecord({ state: 'awaiting_review', createdAt: NOW - 10_000_000 })
    expect(shouldPrune(record, NOW)).toBe(false)
  })
})

describe('admissionCheck', () => {
  it('admits when under both bounds', () => {
    expect(admissionCheck([], 1, 0)).toBe('ok')
  })

  it('rejects once a single frame reaches MAX_PENDING_PER_FRAME active requests', () => {
    const active = Array.from({ length: MAX_PENDING_PER_FRAME }, (_, index) =>
      makeRecord({ requestId: `r${index}`, tabId: 1, frameId: 0, state: 'awaiting_review' }),
    )
    expect(admissionCheck(active, 1, 0)).toBe('frame-limit')
  })

  it('a busy frame does not block a DIFFERENT frame in the same tab', () => {
    const active = Array.from({ length: MAX_PENDING_PER_FRAME }, (_, index) =>
      makeRecord({ requestId: `r${index}`, tabId: 1, frameId: 0, state: 'awaiting_review' }),
    )
    expect(admissionCheck(active, 1, 1)).toBe('ok')
  })

  it('rejects once the global bound is reached even across many distinct frames', () => {
    const active = Array.from({ length: MAX_PENDING_GLOBAL }, (_, index) =>
      makeRecord({ requestId: `r${index}`, tabId: index, frameId: 0, state: 'awaiting_review' }),
    )
    expect(admissionCheck(active, 999, 0)).toBe('global-limit')
  })

  it('admits right up to the boundary and rejects the very next request', () => {
    const active = Array.from({ length: MAX_PENDING_PER_FRAME - 1 }, (_, index) =>
      makeRecord({ requestId: `r${index}`, tabId: 1, frameId: 0, state: 'awaiting_review' }),
    )
    expect(admissionCheck(active, 1, 0)).toBe('ok')
    active.push(makeRecord({ requestId: 'boundary', tabId: 1, frameId: 0, state: 'awaiting_review' }))
    expect(admissionCheck(active, 1, 0)).toBe('frame-limit')
  })
})

describe('validatePendingRequestRecord (adversarial storage deserialization)', () => {
  const valid = makeRecord()

  it('accepts a well-formed record', () => {
    expect(validatePendingRequestRecord(valid)).toEqual(valid)
  })

  it.each([
    null,
    undefined,
    'a-string',
    42,
    [],
    {},
    { ...valid, requestId: '' },
    { ...valid, requestId: 123 },
    { ...valid, requestId: 'x'.repeat(129) },
    { ...valid, adapter: 'metamask' },
    { ...valid, adapter: undefined },
    { ...valid, tabId: '1' },
    { ...valid, tabId: 1.5 },
    { ...valid, frameId: undefined },
    { ...valid, documentBound: 'true' },
    { ...valid, state: 'reviewing' },
    { ...valid, state: undefined },
    { ...valid, protocolVersion: '1' },
    { ...valid, protocolVersion: 1.5 },
    { ...valid, createdAt: 'now' },
    { ...valid, deadlineAt: NaN },
    { ...valid, documentId: 42 },
    { ...valid, networkPassphrase: 42 },
    { ...valid, xdrDigest: 42 },
    { ...valid, windowId: 1.5 },
    { ...valid, settledAt: 'now' },
  ])('rejects malformed input %#', (input) => {
    expect(validatePendingRequestRecord(input)).toBeNull()
  })

  it('accepts optional fields when present and well-formed', () => {
    const withOptionals = makeRecord({
      documentId: 'doc-1',
      networkPassphrase: 'Test SDF Network ; September 2015',
      xdrDigest: 'a'.repeat(64),
      windowId: 7,
      settledAt: NOW,
      state: 'proceed',
    })
    expect(validatePendingRequestRecord(withOptionals)).toEqual(withOptionals)
  })

  it('never copies an unrecognized field from untrusted storage input onto the returned record', () => {
    const withExtra = { ...valid, injected: 'field' }
    const result = validatePendingRequestRecord(withExtra) as unknown as Record<string, unknown>
    expect(result).not.toBeNull()
    expect(result.injected).toBeUndefined()
    expect(Object.keys(result)).not.toContain('injected')
  })
})
