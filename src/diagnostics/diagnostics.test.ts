import { describe, expect, it } from 'vitest'
import {
  BUCKET_MS,
  DIAGNOSTICS_SCHEMA_VERSION,
  DIAGNOSTIC_EVENTS,
  HEALTH_CHECKS,
  MAX_BUCKETS,
  buildReport,
  createState,
  findProhibitedContent,
  floorToHour,
  parseState,
  pruneState,
  recordEvent,
  totalsFor,
  type DiagnosticEvent,
  type DiagnosticsEnvironment,
  type DiagnosticsState,
  type HealthCheck,
  type HealthStatus,
} from './diagnostics'

const HOUR_START = 1_700_000_000_000 - (1_700_000_000_000 % BUCKET_MS)
const RETENTION_OVERSHOOT = (MAX_BUCKETS + 1) * BUCKET_MS

function environment(overrides: Partial<DiagnosticsEnvironment> = {}): DiagnosticsEnvironment {
  return {
    extensionVersion: '0.1.0',
    browser: 'chromium',
    browserMajorVersion: 131,
    platform: 'linux',
    ...overrides,
  }
}

function health(overrides: Partial<Record<HealthCheck, HealthStatus>> = {}) {
  return {
    interception: 'ok',
    bridge: 'ok',
    background: 'ok',
    oracle: 'degraded',
    storage: 'ok',
    ...overrides,
  } as Record<HealthCheck, HealthStatus>
}

function stateWith(entries: Array<[number, DiagnosticEvent]>): DiagnosticsState {
  return entries.reduce(
    (state, [at, event]) => recordEvent(state, event, at),
    createState() as DiagnosticsState,
  )
}

describe('floorToHour', () => {
  it('rounds a timestamp down to the start of its hour', () => {
    expect(floorToHour(HOUR_START + BUCKET_MS - 1)).toBe(HOUR_START)
    expect(floorToHour(HOUR_START)).toBe(HOUR_START)
  })
})

describe('recordEvent', () => {
  it('creates an hour bucket for the first event', () => {
    const state = recordEvent(createState(), 'decode.success', HOUR_START + 42)

    expect(state.schemaVersion).toBe(DIAGNOSTICS_SCHEMA_VERSION)
    expect(state.buckets).toEqual([{ hourStart: HOUR_START, counts: { 'decode.success': 1 } }])
  })

  it('aggregates repeated events within the same hour', () => {
    const state = stateWith([
      [HOUR_START, 'score.timeout'],
      [HOUR_START + 60_000, 'score.timeout'],
      [HOUR_START + 120_000, 'decode.failure'],
    ])

    expect(state.buckets).toHaveLength(1)
    expect(state.buckets[0].counts).toEqual({ 'score.timeout': 2, 'decode.failure': 1 })
  })

  it('opens a new bucket for the next hour and keeps buckets oldest-first', () => {
    const state = stateWith([
      [HOUR_START + BUCKET_MS, 'popup.opened'],
      [HOUR_START, 'popup.opened'],
    ])

    expect(state.buckets.map((bucket) => bucket.hourStart)).toEqual([
      HOUR_START,
      HOUR_START + BUCKET_MS,
    ])
  })

  it('does not mutate the state it was given', () => {
    const original = recordEvent(createState(), 'popup.opened', HOUR_START)
    const snapshot = JSON.stringify(original)

    recordEvent(original, 'popup.opened', HOUR_START)

    expect(JSON.stringify(original)).toBe(snapshot)
  })

  it('rejects an event name that is not in the closed set', () => {
    expect(() =>
      recordEvent(createState(), 'destination.GABC' as DiagnosticEvent, HOUR_START),
    ).toThrow(/Unknown diagnostic event/)
  })

  it('prunes expired buckets while recording', () => {
    const state = stateWith([
      [HOUR_START, 'decode.success'],
      [HOUR_START + MAX_BUCKETS * BUCKET_MS, 'decode.success'],
    ])

    expect(state.buckets.map((bucket) => bucket.hourStart)).toEqual([
      HOUR_START + MAX_BUCKETS * BUCKET_MS,
    ])
  })
})

describe('pruneState', () => {
  it('keeps buckets inside the retention window', () => {
    const state = stateWith([
      [HOUR_START, 'decode.success'],
      [HOUR_START + BUCKET_MS, 'decode.success'],
    ])

    const pruned = pruneState(state, HOUR_START + BUCKET_MS)

    expect(pruned.buckets).toHaveLength(2)
  })

  it('caps retention at MAX_BUCKETS even when timestamps are dense', () => {
    const buckets = Array.from({ length: MAX_BUCKETS + 10 }, (_, index) => ({
      hourStart: HOUR_START + index * BUCKET_MS,
      counts: { 'decode.success': 1 } as Record<string, number>,
    }))

    const pruned = pruneState(
      { schemaVersion: DIAGNOSTICS_SCHEMA_VERSION, buckets },
      HOUR_START + (MAX_BUCKETS + 9) * BUCKET_MS,
    )

    expect(pruned.buckets).toHaveLength(MAX_BUCKETS)
    expect(pruned.buckets[pruned.buckets.length - 1].hourStart).toBe(
      HOUR_START + (MAX_BUCKETS + 9) * BUCKET_MS,
    )
  })
})

describe('parseState', () => {
  it('returns empty state for values that are not diagnostics state', () => {
    expect(parseState(undefined, HOUR_START).buckets).toEqual([])
    expect(parseState(null, HOUR_START).buckets).toEqual([])
    expect(parseState({ buckets: 'nope' }, HOUR_START).buckets).toEqual([])
  })

  it('drops unknown counter keys, non-numeric counts, and malformed buckets', () => {
    const parsed = parseState(
      {
        buckets: [
          null,
          { hourStart: 'yesterday', counts: { 'decode.success': 1 } },
          { hourStart: HOUR_START, counts: null },
          { hourStart: Number.NaN, counts: { 'decode.success': 1 } },
          { hourStart: HOUR_START + BUCKET_MS, counts: { 'destination.GABCDEF': 4 } },
          {
            hourStart: HOUR_START + 5,
            counts: {
              'decode.success': 2.7,
              'destination.GABCDEF': 4,
              'score.timeout': 'many',
              'score.failure': -3,
            },
          },
        ],
      },
      HOUR_START,
    )

    expect(parsed.buckets).toEqual([{ hourStart: HOUR_START, counts: { 'decode.success': 2 } }])
  })

  it('drops buckets outside the retention window', () => {
    const parsed = parseState(
      { buckets: [{ hourStart: HOUR_START, counts: { 'popup.opened': 1 } }] },
      HOUR_START + RETENTION_OVERSHOOT,
    )

    expect(parsed.buckets).toEqual([])
  })
})

describe('totalsFor', () => {
  it('reports every known event, including zeroes, summed across buckets', () => {
    const totals = totalsFor(
      stateWith([
        [HOUR_START, 'popup.decision.cancel'],
        [HOUR_START + BUCKET_MS, 'popup.decision.cancel'],
        [HOUR_START + BUCKET_MS, 'popup.decision.proceed'],
      ]),
    )

    expect(Object.keys(totals)).toHaveLength(DIAGNOSTIC_EVENTS.length)
    expect(totals['popup.decision.cancel']).toBe(2)
    expect(totals['popup.decision.proceed']).toBe(1)
    expect(totals['decode.failure']).toBe(0)
  })
})

describe('findProhibitedContent', () => {
  it('detects a Stellar account, contract, or seed strkey', () => {
    const account = `G${'A'.repeat(55)}`
    const contract = `C${'B'.repeat(55)}`
    const seed = `S${'C'.repeat(55)}`

    expect(findProhibitedContent({ note: account })).toContain('stellar-strkey')
    expect(findProhibitedContent([contract])).toContain('stellar-strkey')
    expect(findProhibitedContent({ nested: { seed } })).toContain('stellar-strkey')
  })

  it('detects XDR-shaped base64, URLs, and email addresses', () => {
    expect(findProhibitedContent({ xdr: `AAAAAg${'x'.repeat(70)}==` })).toContain('xdr-like-base64')
    expect(findProhibitedContent({ page: 'https://dapp.example/swap' })).toContain('url')
    expect(findProhibitedContent({ reporter: 'user@example.com' })).toContain('email')
  })

  it('passes clean counter-only values', () => {
    expect(findProhibitedContent({ 'decode.success': 4, hourStart: HOUR_START })).toEqual([])
  })

  it('treats an unserializable value as empty rather than throwing', () => {
    expect(findProhibitedContent(() => undefined)).toEqual([])
  })
})

describe('buildReport', () => {
  it('builds an hour-rounded report over the retained window', () => {
    const report = buildReport({
      state: stateWith([
        [HOUR_START + 10, 'intercept.request.observed'],
        [HOUR_START + BUCKET_MS + 10, 'score.timeout'],
      ]),
      now: HOUR_START + BUCKET_MS + 999,
      environment: environment(),
      health: health(),
    })

    expect(report.schemaVersion).toBe(DIAGNOSTICS_SCHEMA_VERSION)
    expect(report.generatedAt).toBe(HOUR_START + BUCKET_MS)
    expect(report.windowStart).toBe(HOUR_START)
    expect(report.windowEnd).toBe(HOUR_START + BUCKET_MS)
    expect(report.totals['intercept.request.observed']).toBe(1)
    expect(report.buckets).toHaveLength(2)
    expect(Object.keys(report.health)).toEqual([...HEALTH_CHECKS])
  })

  it('reports null bounds when nothing is retained', () => {
    const report = buildReport({
      state: createState(),
      now: HOUR_START,
      environment: environment(),
      health: health(),
    })

    expect(report.windowStart).toBeNull()
    expect(report.windowEnd).toBeNull()
    expect(report.buckets).toEqual([])
  })

  it('copies state so later recording does not mutate an exported report', () => {
    const state = stateWith([[HOUR_START, 'popup.opened']])
    const report = buildReport({
      state,
      now: HOUR_START,
      environment: environment(),
      health: health(),
    })

    recordEvent(state, 'popup.opened', HOUR_START)

    expect(report.buckets[0].counts['popup.opened']).toBe(1)
  })

  it('accepts an unknown browser version', () => {
    const report = buildReport({
      state: createState(),
      now: HOUR_START,
      environment: environment({ browser: 'firefox', browserMajorVersion: null }),
      health: health(),
    })

    expect(report.environment.browserMajorVersion).toBeNull()
  })

  it('rejects environment fields outside the allowlists', () => {
    const cases: Array<Partial<DiagnosticsEnvironment>> = [
      { extensionVersion: 'GABCDEF-nightly' },
      { browser: 'brave-with-profile-x' as DiagnosticsEnvironment['browser'] },
      { platform: 'user-desktop' as DiagnosticsEnvironment['platform'] },
      { browserMajorVersion: 131.5 },
    ]

    for (const overrides of cases) {
      expect(() =>
        buildReport({
          state: createState(),
          now: HOUR_START,
          environment: environment(overrides),
          health: health(),
        }),
      ).toThrow(/Diagnostics environment rejected/)
    }
  })

  it('rejects an invalid health status', () => {
    expect(() =>
      buildReport({
        state: createState(),
        now: HOUR_START,
        environment: environment(),
        health: health({ oracle: 'https://oracle.example' as HealthStatus }),
      }),
    ).toThrow(/Diagnostics health rejected: invalid status for oracle/)
  })

  it('fails closed when the redaction guard matches injected content', () => {
    const tainted: DiagnosticsState = {
      schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      buckets: [
        {
          hourStart: HOUR_START,
          counts: { [`G${'A'.repeat(55)}`]: 1 } as Partial<Record<DiagnosticEvent, number>>,
        },
      ],
    }

    expect(() =>
      buildReport({
        state: tainted,
        now: HOUR_START,
        environment: environment(),
        health: health(),
      }),
    ).toThrow(/redaction guard: stellar-strkey/)
  })
})
