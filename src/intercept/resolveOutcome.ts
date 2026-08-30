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
 * Production review path.  A malformed envelope is deliberately presented as
 * an incomplete review instead of being allowed; opaque effects always reach
 * the user and only account targets are eligible for destination assessment.
 */
export async function resolveReviewOutcome(
  xdr: string,
  deps: ResolveReviewOutcomeDeps,
  networkPassphrase?: string,
): Promise<Outcome> {
  const review = (deps.extractReview ?? extractTransactionReview)(xdr, networkPassphrase)
  if (!review) return 'cancel'

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

  return deps.requestDecision(aggregateReview(review, evidence))
}

function tierForScore(score: number): 'low' | 'elevated' | 'high' | 'critical' | 'unknown' {
  if (!Number.isFinite(score) || !Number.isInteger(score) || score < 0 || score > 100) return 'unknown'
  return score <= 20 ? 'low' : score <= 50 ? 'elevated' : score <= 75 ? 'high' : 'critical'
}

function tierOrder(tier: string): number {
  switch (tier) {
    case 'critical':
      return 5
    case 'high':
      return 4
    case 'elevated':
      return 3
    case 'low':
      return 2
    case 'unknown':
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
      const score = await deps.getScore(destination).catch(() => Number.NaN)
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
