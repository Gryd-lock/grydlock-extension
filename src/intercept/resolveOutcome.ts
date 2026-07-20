import type { Decision, Outcome, RuntimeDecisionMadeMessage } from './protocol'
import type { DecodedBatch, DecodedDestination } from '../decode/decodeTransaction'

export interface ResolveOutcomeDeps {
  extractDestination: (xdr: string) => DecodedBatch | null
  getScore: (destination: string) => Promise<number>
  requestDecision: (info: {
    destinations: DecodedDestination[]
    scores: Array<{ destination: string; asset?: string; score: number }>
    worstScore: number
  }) => Promise<Decision>
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
      const score = await deps.getScore(destination)
      return { destination, asset, score }
    }),
  )

  const worst = scores.reduce((acc, item) => (tierOrder(tierForScore(item.score)) > tierOrder(tierForScore(acc.score)) ? item : acc), scores[0])

  return deps.requestDecision({
    destinations: decoded.destinations,
    scores,
    worstScore: worst.score,
  })
}
