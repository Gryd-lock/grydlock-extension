import type { Decision, Outcome } from './protocol'

export interface ResolveOutcomeDeps {
  extractDestination: (xdr: string) => { destination: string; asset?: string } | null
  getScore: (destination: string) => Promise<number>
  requestDecision: (info: { destination: string; asset?: string; score: number | null }) => Promise<Decision>
}

/**
 * Decides what should happen to a pending signTransaction call: 'allow' when
 * no single destination can be determined (nothing to warn about — Gryd Lock
 * never blocks what it can't assess), otherwise scores the destination and
 * defers to the user's proceed/cancel decision.
 */
export async function resolveOutcome(xdr: string, deps: ResolveOutcomeDeps): Promise<Outcome> {
  const decoded = deps.extractDestination(xdr)
  if (!decoded) return 'allow'

  // If the oracle is unreachable we must NOT silently allow: that would
  // conflate "nothing to warn about" with "couldn't assess". Instead we
  // open the popup with a null score so the user can make an informed choice.
  let score: number | null
  try {
    score = await deps.getScore(decoded.destination)
  } catch {
    score = null
  }

  return deps.requestDecision({ destination: decoded.destination, asset: decoded.asset, score })
}
