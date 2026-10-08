import type { Decision, Outcome } from './protocol'
import type { DecodedBatch, DecodedDestination } from '../decode/decodeTransaction'
import { extractTransactionReview, scoreableTargets } from '../decode/transactionReview'
import { aggregateReview } from '../review/policy'
import type { AggregatedReview, ReviewTarget, TargetEvidence } from '../review/model'

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
  getScore: (target: ReviewTarget) => Promise<number>
  requestDecision: (review: AggregatedReview) => Promise<Decision>
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
  deps: Pick<ResolveReviewOutcomeDeps, 'extractReview' | 'getScore'>,
  networkPassphrase?: string,
): Promise<AggregatedReview | null> {
  const review = (deps.extractReview ?? extractTransactionReview)(xdr, networkPassphrase)
  if (!review) return null

  const evidence: TargetEvidence[] = await Promise.all(
    scoreableTargets(review).map(async (target) => {
      try {
        const score = await deps.getScore(target)
        return Number.isFinite(score) && Number.isInteger(score) && score >= 0 && score <= 100
          ? { target, score, status: 'available' as const }
          : { target, status: 'unavailable' as const }
      } catch {
        return { target, status: 'unavailable' as const }
      }
    }),
  )

  return aggregateReview(review, evidence)
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

export type RiskTier = 'unknown' | 'low' | 'elevated' | 'high' | 'critical'

export function tierForScore(score: number): RiskTier {
  if (score < 0 || !Number.isFinite(score)) return 'unknown'
  return score <= 20 ? 'low' : score <= 50 ? 'elevated' : score <= 75 ? 'high' : 'critical'
}

export function tierOrder(tier: string): number {
  switch (tier) {
    case 'critical':
      return 5
    case 'high':
      return 4
    case 'unknown':
      return 3
    case 'elevated':
      return 2
    case 'low':
      return 1
    default:
      return 0
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
