import type { Decision, Outcome } from './protocol'
import type { DecodedBatch, DecodedDestination } from '../decode/decodeTransaction'
import { extractTransactionReview, scoreableTargets } from '../decode/transactionReview'
import { aggregateReview } from '../review/policy'
import type { AggregatedReview, OracleSourceKind, ReviewTarget, TargetEvidence } from '../review/model'
import type { ScoreLookup } from '../adapter/oracleAdapter'

export interface ResolveOutcomeDeps {
  extractDestination: (xdr: string, networkPassphrase?: string) => DecodedBatch | null
  getScore: (destination: string) => Promise<number>
  requestDecision: (info: {
    destinations: DecodedDestination[]
    scores: Array<{ destination: string; asset?: string; score: number }>
    worstScore: number
  }) => Promise<Decision>
}

export interface ResolveReviewOutcomeDeps {
  extractReview?: typeof extractTransactionReview
  /**
   * The review boundary keeps score requests network-scoped and typed. The
   * adapter may project only approved account targets to its legacy API.
   */
  getScore?: (target: ReviewTarget) => Promise<number>
  /**
   * Typed lookup that distinguishes "no score for this target" from "oracle
   * failed". Preferred over `getScore` when both are supplied. When neither
   * is supplied, destination scoring is off and no score is invented.
   */
  lookupScore?: (target: ReviewTarget) => Promise<ScoreLookup>
  oracleSource?: OracleSourceKind
  requestDecision: (review: AggregatedReview) => Promise<Decision>
}

async function evidenceFor(
  target: ReviewTarget,
  deps: Pick<ResolveReviewOutcomeDeps, 'getScore' | 'lookupScore'>,
): Promise<TargetEvidence> {
  if (deps.lookupScore) {
    try {
      const lookup = await deps.lookupScore(target)
      return lookup.status === 'available'
        ? { target, score: lookup.score, status: 'available' }
        : { target, status: lookup.status }
    } catch {
      return { target, status: 'unavailable' }
    }
  }
  if (!deps.getScore) return { target, status: 'not-configured' }
  try {
    const score = await deps.getScore(target)
    return Number.isFinite(score) && Number.isInteger(score) && score >= 0 && score <= 100
      ? { target, score, status: 'available' }
      : { target, status: 'unavailable' }
  } catch {
    return { target, status: 'unavailable' }
  }
}

/**
 * Builds the bounded, scored review without waiting on a user decision. A
 * malformed envelope deliberately produces `null` instead of an implicit
 * allow; opaque effects always reach the user and only account targets are
 * eligible for destination assessment.
 *
 * Split out from resolveReviewOutcome so a caller (the background worker's
 * signing state machine) can persist durable pending-request state and
 * respond to its caller before a user decision exists, rather than holding
 * a message port open for the full review-plus-popup duration — a worker
 * kept alive only by an open port is not resilient to MV3 suspension.
 */
export async function buildAggregatedReview(
  xdr: string,
  deps: Pick<ResolveReviewOutcomeDeps, 'extractReview' | 'getScore' | 'lookupScore' | 'oracleSource'>,
  networkPassphrase?: string,
): Promise<AggregatedReview | null> {
  const review = (deps.extractReview ?? extractTransactionReview)(xdr, networkPassphrase)
  if (!review) return null

  const evidence = await Promise.all(
    scoreableTargets(review).map((target) => evidenceFor(target, deps)),
  )

  const aggregated = aggregateReview(review, evidence)
  return deps.oracleSource ? { ...aggregated, oracleSource: deps.oracleSource } : aggregated
}

/** Production review path used where a single Promise spanning the whole review-plus-decision is acceptable (e.g. tests, the legacy non-durable caller). */
export async function resolveReviewOutcome(
  xdr: string,
  deps: ResolveReviewOutcomeDeps,
  networkPassphrase?: string,
): Promise<Outcome> {
  const review = await buildAggregatedReview(xdr, deps, networkPassphrase)
  if (!review) return 'cancel'
  return deps.requestDecision(review)
}

function tierForScore(score: number): 'low' | 'elevated' | 'high' | 'critical' {
  return score <= 20 ? 'low' : score <= 50 ? 'elevated' : score <= 75 ? 'high' : 'critical'
}

function tierOrder(tier: string): number {
  switch (tier) {
    case 'critical':
      return 4
    case 'high':
      return 3
    case 'elevated':
      return 2
    default:
      return 1
  }
}

/**
 * Decides what should happen to a pending signTransaction call.
 *
 * 'allow' when no destinations can be determined (malformed XDR or no
 * destination-bearing operation) — this preserves the original "can't
 * assess" behaviour.
 *
 * When there are destinations, each is scored independently. The worst-tier
 * destination drives the warning so a malicious entry in a larger batch
 * can't be hidden by low-risk peers.
 */
export async function resolveOutcome(
  xdr: string,
  deps: ResolveOutcomeDeps,
  networkPassphrase?: string,
): Promise<Outcome> {
  const decoded = deps.extractDestination(xdr, networkPassphrase)
  if (!decoded) return 'allow'

  const scores = await Promise.all(
    decoded.destinations.map(async ({ destination, asset }) => {
      const score = await deps.getScore(destination).catch(() => -1)
      return { destination, asset, score }
    }),
  )

  const worst = scores.reduce(
    (acc, item) =>
      tierOrder(tierForScore(item.score)) > tierOrder(tierForScore(acc.score)) ? item : acc,
    scores[0],
  )

  return deps.requestDecision({
    destinations: decoded.destinations,
    scores,
    worstScore: worst.score,
  })
}
