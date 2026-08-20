/**
 * Spike prototype for the privacy-preserving local diagnostics model described in
 * `docs/spikes/0116-privacy-preserving-local-diagnostics.md`.
 *
 * The module is deliberately pure: it owns the diagnostics *shape*, the retention
 * arithmetic, and the redaction guard, but performs no storage, no messaging, and no
 * network access. Nothing in the shipped extension imports it yet; wiring the counters
 * into the background worker and adding an export UI is bounded follow-up work.
 *
 * Privacy invariants enforced here:
 *
 * 1. Only counters keyed by a closed set of event names are recorded. There is no code
 *    path that accepts free-form strings from transaction, wallet, or page data.
 * 2. Timestamps are rounded down to the hour, so a report cannot be correlated with an
 *    individual signing request.
 * 3. Environment fields are validated against allowlists and a semver pattern.
 * 4. Every report is scanned before it is returned, and building fails loudly if any
 *    prohibited pattern (strkey, XDR-shaped base64, URL, email) appears anywhere in it.
 */

export const DIAGNOSTICS_SCHEMA_VERSION = 1

/** Counter granularity. Hour buckets keep reports small and non-correlatable. */
export const BUCKET_MS = 3_600_000

/** Rolling retention window: 7 days of hourly buckets. */
export const MAX_BUCKETS = 168
export const RETENTION_MS = MAX_BUCKETS * BUCKET_MS

/**
 * Closed set of recordable events. Adding a member is a privacy-review change: an event
 * name must describe a code path, never a value observed in a transaction.
 */
export const DIAGNOSTIC_EVENTS = [
  'intercept.request.observed',
  'intercept.request.replayed',
  'intercept.request.cancelled',
  'intercept.listener.registered',
  'decode.success',
  'decode.unsupported',
  'decode.failure',
  'score.fresh',
  'score.cache_hit',
  'score.timeout',
  'score.breaker_open',
  'score.failure',
  'popup.opened',
  'popup.decision.proceed',
  'popup.decision.cancel',
  'popup.closed_without_decision',
  'runtime.message_dropped',
  'runtime.worker_start',
  'storage.write_failure',
] as const

export type DiagnosticEvent = (typeof DIAGNOSTIC_EVENTS)[number]

const EVENT_SET: ReadonlySet<string> = new Set(DIAGNOSTIC_EVENTS)

/** Runtime health probes surfaced in the report and, later, in a health UI. */
export const HEALTH_CHECKS = ['interception', 'bridge', 'background', 'oracle', 'storage'] as const

export type HealthCheck = (typeof HEALTH_CHECKS)[number]
export type HealthStatus = 'ok' | 'degraded' | 'failed' | 'unknown'

const HEALTH_STATUSES: ReadonlySet<string> = new Set(['ok', 'degraded', 'failed', 'unknown'])

export const BROWSER_FAMILIES = ['chromium', 'firefox', 'other'] as const
export const PLATFORMS = ['windows', 'macos', 'linux', 'other'] as const

export type BrowserFamily = (typeof BROWSER_FAMILIES)[number]
export type Platform = (typeof PLATFORMS)[number]

export interface DiagnosticsEnvironment {
  /** Extension version from the manifest, e.g. `0.1.0`. */
  extensionVersion: string
  /** Coarse browser family; never the full user-agent string. */
  browser: BrowserFamily
  /** Major version only, or `null` when it cannot be determined. */
  browserMajorVersion: number | null
  platform: Platform
}

export interface DiagnosticsBucket {
  /** Unix ms rounded down to the start of the hour. */
  hourStart: number
  counts: Partial<Record<DiagnosticEvent, number>>
}

export interface DiagnosticsState {
  schemaVersion: number
  /** Ordered oldest-first, one entry per hour that recorded at least one event. */
  buckets: DiagnosticsBucket[]
}

export interface DiagnosticsReport {
  schemaVersion: number
  /** Hour-rounded generation time. */
  generatedAt: number
  /** Hour-rounded bounds of the retained window, or `null` when nothing is retained. */
  windowStart: number | null
  windowEnd: number | null
  environment: DiagnosticsEnvironment
  health: Record<HealthCheck, HealthStatus>
  /** Every known event, including zeroes, so report shape does not vary by user. */
  totals: Record<DiagnosticEvent, number>
  buckets: DiagnosticsBucket[]
}

/**
 * Patterns that must never appear in a diagnostics report. The guard is a backstop, not
 * the primary control — the primary control is that no value-bearing field exists.
 */
const PROHIBITED_PATTERNS: Array<{ rule: string; pattern: RegExp }> = [
  { rule: 'stellar-strkey', pattern: /\b[GMSCT][A-Z2-7]{54,}\b/ },
  { rule: 'xdr-like-base64', pattern: /[A-Za-z0-9+/]{64,}={0,2}/ },
  { rule: 'url', pattern: /\bhttps?:\/\//i },
  { rule: 'email', pattern: /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/ },
]

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

export function floorToHour(timestamp: number): number {
  return Math.floor(timestamp / BUCKET_MS) * BUCKET_MS
}

export function createState(): DiagnosticsState {
  return { schemaVersion: DIAGNOSTICS_SCHEMA_VERSION, buckets: [] }
}

/**
 * Drops buckets that fall outside the retention window and caps the total, keeping the
 * newest entries. Callers should prune on read as well as on write so that retention
 * holds even for a profile that stopped recording.
 */
export function pruneState(state: DiagnosticsState, now: number): DiagnosticsState {
  const cutoff = floorToHour(now) - RETENTION_MS
  const retained = state.buckets.filter((bucket) => bucket.hourStart > cutoff).slice(-MAX_BUCKETS)

  return { schemaVersion: DIAGNOSTICS_SCHEMA_VERSION, buckets: retained }
}

/**
 * Records one occurrence of `event` in the bucket for `now`, returning a new state.
 * Unknown event names are rejected rather than stored, so a compromised caller cannot
 * smuggle a destination address into the counter keys.
 */
export function recordEvent(
  state: DiagnosticsState,
  event: DiagnosticEvent,
  now: number,
): DiagnosticsState {
  if (!EVENT_SET.has(event)) {
    throw new Error(`Unknown diagnostic event: ${String(event)}`)
  }

  const hourStart = floorToHour(now)
  const pruned = pruneState(state, now)
  const existing = pruned.buckets.find((bucket) => bucket.hourStart === hourStart)

  if (existing) {
    const updated: DiagnosticsBucket = {
      hourStart,
      counts: { ...existing.counts, [event]: (existing.counts[event] ?? 0) + 1 },
    }
    return {
      schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      buckets: pruned.buckets.map((bucket) => (bucket.hourStart === hourStart ? updated : bucket)),
    }
  }

  const buckets = [...pruned.buckets, { hourStart, counts: { [event]: 1 } }]
  buckets.sort((a, b) => a.hourStart - b.hourStart)

  return { schemaVersion: DIAGNOSTICS_SCHEMA_VERSION, buckets: buckets.slice(-MAX_BUCKETS) }
}

/**
 * Rebuilds state from untrusted storage, discarding anything that does not match the
 * schema. Persisted diagnostics are attacker-writable in a compromised profile, so the
 * loader never trusts stored keys.
 */
export function parseState(value: unknown, now: number): DiagnosticsState {
  const candidate = value as { buckets?: unknown } | null | undefined
  if (!candidate || !Array.isArray(candidate.buckets)) return createState()

  const buckets: DiagnosticsBucket[] = []

  for (const entry of candidate.buckets) {
    const bucket = entry as { hourStart?: unknown; counts?: unknown } | null
    if (!bucket || typeof bucket.hourStart !== 'number' || !Number.isFinite(bucket.hourStart)) {
      continue
    }
    if (!bucket.counts || typeof bucket.counts !== 'object') continue

    const counts: Partial<Record<DiagnosticEvent, number>> = {}
    for (const [key, count] of Object.entries(bucket.counts as Record<string, unknown>)) {
      if (!EVENT_SET.has(key)) continue
      if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) continue
      counts[key as DiagnosticEvent] = Math.floor(count)
    }

    if (Object.keys(counts).length === 0) continue
    buckets.push({ hourStart: floorToHour(bucket.hourStart), counts })
  }

  buckets.sort((a, b) => a.hourStart - b.hourStart)

  return pruneState({ schemaVersion: DIAGNOSTICS_SCHEMA_VERSION, buckets }, now)
}

/** Sums every retained bucket, reporting all known events including zeroes. */
export function totalsFor(state: DiagnosticsState): Record<DiagnosticEvent, number> {
  const totals = Object.fromEntries(DIAGNOSTIC_EVENTS.map((event) => [event, 0])) as Record<
    DiagnosticEvent,
    number
  >

  for (const bucket of state.buckets) {
    for (const event of DIAGNOSTIC_EVENTS) {
      totals[event] += bucket.counts[event] ?? 0
    }
  }

  return totals
}

/** Returns the names of prohibited-content rules matched anywhere in `value`. */
export function findProhibitedContent(value: unknown): string[] {
  const serialized = JSON.stringify(value) ?? ''

  return PROHIBITED_PATTERNS.filter(({ pattern }) => pattern.test(serialized)).map(
    ({ rule }) => rule,
  )
}

function assertEnvironment(environment: DiagnosticsEnvironment): void {
  if (!SEMVER_PATTERN.test(environment.extensionVersion)) {
    throw new Error('Diagnostics environment rejected: extensionVersion is not a semver string')
  }
  if (!(BROWSER_FAMILIES as readonly string[]).includes(environment.browser)) {
    throw new Error('Diagnostics environment rejected: unknown browser family')
  }
  if (!(PLATFORMS as readonly string[]).includes(environment.platform)) {
    throw new Error('Diagnostics environment rejected: unknown platform')
  }

  const major = environment.browserMajorVersion
  if (major !== null && (!Number.isInteger(major) || major < 0)) {
    throw new Error('Diagnostics environment rejected: browserMajorVersion must be an integer')
  }
}

function assertHealth(health: Record<HealthCheck, HealthStatus>): void {
  for (const check of HEALTH_CHECKS) {
    if (!HEALTH_STATUSES.has(health[check])) {
      throw new Error(`Diagnostics health rejected: invalid status for ${check}`)
    }
  }
}

export interface BuildReportInput {
  state: DiagnosticsState
  now: number
  environment: DiagnosticsEnvironment
  health: Record<HealthCheck, HealthStatus>
}

/**
 * Produces the report a user can view locally or export as a support bundle. Export is a
 * user-initiated action; this function performs no persistence or sharing itself.
 *
 * Throws when the environment or health input is out of contract, or when the redaction
 * guard matches — failing to produce a report is always preferable to leaking one.
 */
export function buildReport({
  state,
  now,
  environment,
  health,
}: BuildReportInput): DiagnosticsReport {
  assertEnvironment(environment)
  assertHealth(health)

  const pruned = pruneState(state, now)
  const first = pruned.buckets[0]
  const last = pruned.buckets[pruned.buckets.length - 1]

  const report: DiagnosticsReport = {
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    generatedAt: floorToHour(now),
    windowStart: first ? first.hourStart : null,
    windowEnd: last ? last.hourStart : null,
    environment: { ...environment },
    health: { ...health },
    totals: totalsFor(pruned),
    buckets: pruned.buckets.map((bucket) => ({
      hourStart: bucket.hourStart,
      counts: { ...bucket.counts },
    })),
  }

  const violations = findProhibitedContent(report)
  if (violations.length > 0) {
    throw new Error(`Diagnostics report rejected by redaction guard: ${violations.join(', ')}`)
  }

  return report
}
