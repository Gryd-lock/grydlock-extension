import type { Decision, Outcome } from './protocol'

export interface ResolveOutcomeDeps {
  extractDestination: (xdr: string, networkPassphrase?: string) => { destination: string; asset?: string } | null
  getScore: (destination: string) => Promise<number>
  requestDecision: (info: { destination: string; asset?: string; score: number }) => Promise<Decision>
}

/**
 * Decides what should happen to a pending signTransaction call: 'allow' when
 * no single destination can be determined (nothing to warn about — Gryd Lock
 * never blocks what it can't assess), otherwise scores the destination and
 * defers to the user's proceed/cancel decision.
 */
export async function resolveOutcome(
  xdr: string,
  deps: ResolveOutcomeDeps,
  networkPassphrase?: string,
): Promise<Outcome> {
  const decoded = deps.extractDestination(xdr, networkPassphrase)
  if (!decoded) return 'allow'

  const score = await deps.getScore(decoded.destination)
  return deps.requestDecision({ destination: decoded.destination, asset: decoded.asset, score })
}
