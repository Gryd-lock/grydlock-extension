import {
  CircuitBreakerOracle,
  OracleError,
  StubOracle,
  compose,
  withCache,
  withTimeout,
  type RiskOracle,
} from 'grydlock-oracle-adapter'
import {
  ORACLE_BREAKER_COOLDOWN_MS,
  ORACLE_BREAKER_FAILURE_THRESHOLD,
  ORACLE_CACHE_MAX_ENTRIES,
  ORACLE_CACHE_TTL_MS,
  ORACLE_TIMEOUT_MS,
} from './config'

/**
 * Which score source the extension consults for destination risk. `off` is
 * the default: the extension then shows its local transaction review only
 * and never fabricates a destination score.
 */
export type OracleSourceConfig = { kind: 'off' } | { kind: 'testkit-fixtures' }

export const DEFAULT_ORACLE_SOURCE: OracleSourceConfig = { kind: 'off' }

/** Typed outcome of asking the configured oracle about one destination. */
export type ScoreLookup =
  | { status: 'available'; score: number }
  /** The oracle answered, but has no score for this destination. */
  | { status: 'unscored' }
  /** The oracle was configured but could not answer (timeout, network, breaker open, bad response). */
  | { status: 'unavailable' }

/**
 * `StubOracle` resolves `0` for any destination missing from the vendored
 * grydlock-testkit fixtures ("so the extension always has a number to
 * render"). Rendering that as "Low risk" would be a fabricated result, so
 * the fixture source maps it back to an explicit "not in fixtures" answer.
 * The testkit fixture set deliberately contains no 0-scored destination;
 * `oracleAdapter.test.ts` pins that against the testkit itself.
 */
export const STUB_ORACLE_UNKNOWN_SCORE = 0

class UnscoredDestination extends Error {
  constructor() {
    super('Destination not present in the configured score source.')
    this.name = 'UnscoredDestination'
  }
}

class TestkitFixtureOracle implements RiskOracle {
  private readonly stub = new StubOracle()

  async getScore(destination: string): Promise<number> {
    const score = await this.stub.getScore(destination)
    if (score === STUB_ORACLE_UNKNOWN_SCORE) throw new UnscoredDestination()
    return score
  }
}

function withResilience(base: RiskOracle): RiskOracle {
  // Circuit breaker wraps the timeout so repeated timeouts trip it; the cache
  // sits outermost so a cached answer never waits on a tripped breaker.
  const guarded = new CircuitBreakerOracle(withTimeout({ timeoutMs: ORACLE_TIMEOUT_MS })(base), {
    failureThreshold: ORACLE_BREAKER_FAILURE_THRESHOLD,
    cooldownWindow: ORACLE_BREAKER_COOLDOWN_MS,
  })
  return compose(withCache({ ttlMs: ORACLE_CACHE_TTL_MS, maxEntries: ORACLE_CACHE_MAX_ENTRIES }))(
    guarded,
  )
}

/** Builds the oracle for a source, or `null` when scoring is switched off. */
export function createRiskOracle(source: OracleSourceConfig): RiskOracle | null {
  switch (source.kind) {
    case 'off':
      return null
    case 'testkit-fixtures':
      return withResilience(new TestkitFixtureOracle())
  }
}

function isUnscoredError(error: unknown): boolean {
  return (
    error instanceof UnscoredDestination ||
    (error instanceof OracleError &&
      (error.code === 'UNRECOGNIZED_DESTINATION' || error.code === 'SCORE_NOT_YET_COMPUTED'))
  )
}

/** Asks `oracle` for one destination's score, classifying every failure instead of inventing a number. */
export async function lookupScore(oracle: RiskOracle, destination: string): Promise<ScoreLookup> {
  try {
    const score = await oracle.getScore(destination)
    return Number.isInteger(score) && score >= 0 && score <= 100
      ? { status: 'available', score }
      : { status: 'unavailable' }
  } catch (error) {
    return isUnscoredError(error) ? { status: 'unscored' } : { status: 'unavailable' }
  }
}
