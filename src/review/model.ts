/**
 * The review schema is deliberately a local, versioned contract.  It is not
 * sent to an oracle and is kept in the extension process while a user reviews
 * a signing request.
 */
export const REVIEW_SCHEMA_VERSION = 1 as const
export const REVIEW_POLICY_VERSION = 1 as const

export type Coverage = 'understood' | 'partial' | 'opaque'
export type ReviewSeverity = 'info' | 'warning' | 'high' | 'critical'
export type TargetType = 'account' | 'contract' | 'claimable-balance' | 'liquidity-pool'

export interface ReviewTarget {
  type: TargetType
  value: string
  /**
   * Exact passphrase that scopes this identifier. Account and contract
   * strings are not meaningful enough on their own to cross a network
   * boundary.
   */
  networkPassphrase: string
  /** Human-readable asset identity, never used as an oracle target. */
  asset?: string
}

export interface ReviewFact {
  label: string
  value: string
  /** Facts derived only from XDR are never represented as observed ledger state. */
  provenance: 'xdr' | 'static-inference'
}

export interface ReviewFinding {
  code: string
  severity: ReviewSeverity
  title: string
  detail: string
  operationIndex?: number
}

export interface ReviewOperation {
  index: number
  type: string
  source: string
  coverage: Coverage
  summary: string
  facts: ReviewFact[]
  targets: ReviewTarget[]
  findings: ReviewFinding[]
}

export interface ReviewEnvelope {
  type: 'transaction' | 'fee-bump'
  source: string
  /** Fee payer for fee-bump envelopes; intentionally distinct from inner source. */
  feeSource?: string
  operationCount: number
}

export interface TransactionReview {
  schemaVersion: typeof REVIEW_SCHEMA_VERSION
  policyVersion: typeof REVIEW_POLICY_VERSION
  /** Network passphrase exactly as supplied/resolved, never inferred for display. */
  networkPassphrase: string
  /** Network-bound transaction hash produced by the SDK for this exact envelope. */
  xdrDigest: string
  envelope: ReviewEnvelope
  memo?: ReviewFact
  operations: ReviewOperation[]
  findings: ReviewFinding[]
}

/**
 * - `available`: the configured oracle returned a 0–100 score.
 * - `unscored`: the oracle answered but has no score for this target.
 * - `unavailable`: an oracle is configured but could not answer.
 * - `not-configured`: destination scoring is switched off.
 */
export type EvidenceStatus = 'available' | 'unscored' | 'unavailable' | 'not-configured'

/** Settings-level identity of the score source; never a user-facing score. */
export type OracleSourceKind = 'off' | 'testkit-fixtures' | 'soroban'

export interface TargetEvidence {
  target: ReviewTarget
  score?: number
  status: EvidenceStatus
}

export interface AggregatedReview {
  review: TransactionReview
  evidence: TargetEvidence[]
  /** Which score source produced `evidence`. Absent on reviews built before this field existed. */
  oracleSource?: OracleSourceKind
  severity: ReviewSeverity
  findings: ReviewFinding[]
}

export const severityRank: Record<ReviewSeverity, number> = {
  info: 0,
  warning: 1,
  high: 2,
  critical: 3,
}

export function mostSevere(findings: readonly ReviewFinding[]): ReviewSeverity {
  return findings.reduce<ReviewSeverity>(
    (current, finding) =>
      severityRank[finding.severity] > severityRank[current] ? finding.severity : current,
    'info',
  )
}
