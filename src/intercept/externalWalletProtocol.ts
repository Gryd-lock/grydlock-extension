/**
 * External wallet protocol contracts — Freighter and Albedo.
 *
 * Distinct from ./protocol.ts: that file governs Gryd Lock's OWN internal
 * message bus (bridge <-> background <-> popup), which cannot drift since
 * Gryd Lock controls both ends. This file governs the boundary Gryd Lock does
 * NOT control — what a real installed Freighter/Albedo build actually sends.
 *
 * Uses zod (v4). Note v4 deprecates chained string-format validators like
 * `.url()`/`.email()` in favor of top-level `z.url()`/`z.email()` — none are
 * needed here, but keep this in mind if extending this file.
 *
 * PROVENANCE — read before editing:
 *   Fields marked "confirmed" are taken byte-for-byte from the existing
 *   fixtures in tests/fixtures/contracts/{freighter,albedo}/, which
 *   src/tests/walletContracts.test.ts already asserts against. Fields marked
 *   "unconfirmed" have NOT been checked against a real wallet response.
 *   Only the DECLINE/REJECT path is confirmed for both wallets — neither
 *   wallet's SUCCESS response shape has been verified anywhere in this repo
 *   yet. That is the single highest-value thing to capture next via
 *   e2e/real/real-freighter-version.spec.ts.
 *
 *   Do not tighten an "unconfirmed" schema into something authoritative-
 *   looking until it's been verified against a real captured message.
 */
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Freighter
// ---------------------------------------------------------------------------

export const FreighterSubmitTransactionRequestSchema = z.object({
  source: z.literal('FREIGHTER_EXTERNAL_MSG_REQUEST'),
  type: z.literal('SUBMIT_TRANSACTION'),
  transactionXdr: z.string().min(1),
  networkPassphrase: z.string().min(1),
  accountToSign: z.string().optional(), // confirmed present in the real fixture
})
export type FreighterSubmitTransactionRequest = z.infer<
  typeof FreighterSubmitTransactionRequestSchema
>

export function isFreighterSubmitTransactionRequest(
  msg: unknown,
): msg is FreighterSubmitTransactionRequest {
  return FreighterSubmitTransactionRequestSchema.safeParse(msg).success
}

// CONFIRMED shape (decline-response.json) only. `signedTransaction` is
// UNCONFIRMED — no success fixture exists yet, do not trust this field name.
export const FreighterSubmitTransactionResponseSchema = z.object({
  source: z.literal('FREIGHTER_EXTERNAL_MSG_RESPONSE'),
  type: z.literal('SUBMIT_TRANSACTION_RESPONSE'),
  status: z.string(), // only 'rejected' is confirmed; kept loose deliberately
  error: z.string().optional(),
  signedTransaction: z.string().optional(), // UNCONFIRMED
})
export type FreighterSubmitTransactionResponse = z.infer<
  typeof FreighterSubmitTransactionResponseSchema
>

export function isFreighterSubmitTransactionResponse(
  msg: unknown,
): msg is FreighterSubmitTransactionResponse {
  return FreighterSubmitTransactionResponseSchema.safeParse(msg).success
}

export function isFreighterDecline(msg: unknown): boolean {
  const result = FreighterSubmitTransactionResponseSchema.safeParse(msg)
  return (
    result.success && result.data.status === 'rejected' && typeof result.data.error === 'string'
  )
}

// ---------------------------------------------------------------------------
// Albedo
// ---------------------------------------------------------------------------

// CONFIRMED shape (tx-intent-request.json) only. Earlier drafts of this file
// guessed at `callback`, `submit`, and additional intent values
// ('public_key'/'sign_message'/'implicit_flow'/'exchange') — NONE confirmed.
export const AlbedoIntentRequestSchema = z.object({
  intent: z.string(), // only 'tx' confirmed; kept loose deliberately
  xdr: z.string().optional(),
  network: z.string().optional(),
  __reqid: z.string(),
})
export type AlbedoIntentRequest = z.infer<typeof AlbedoIntentRequestSchema>

export function isAlbedoIntentRequest(msg: unknown): msg is AlbedoIntentRequest {
  return AlbedoIntentRequestSchema.safeParse(msg).success
}

export function isDestinationBearingAlbedoIntent(msg: unknown): msg is AlbedoIntentRequest {
  const result = AlbedoIntentRequestSchema.safeParse(msg)
  return (
    result.success &&
    ['tx', 'pay'].includes(result.data.intent) &&
    typeof result.data.xdr === 'string'
  )
}

// CONFIRMED shape (reject-response.json) only. Structurally nested under
// `albedoIntentResult` — NOT the flat shape an earlier draft assumed.
// Success (non -4 code) path is UNCONFIRMED.
export const AlbedoIntentResultSchema = z.object({
  intent: z.string(),
  status: z.string(), // only 'rejected' confirmed
  code: z.number().optional(), // -4 confirmed as "rejected by user"; others unconfirmed
  message: z.string().optional(),
  __reqid: z.string(),
})

export const AlbedoIntentResponseEnvelopeSchema = z.object({
  albedoIntentResult: AlbedoIntentResultSchema,
})
export type AlbedoIntentResponseEnvelope = z.infer<typeof AlbedoIntentResponseEnvelopeSchema>

export function isAlbedoIntentResponseEnvelope(msg: unknown): msg is AlbedoIntentResponseEnvelope {
  return AlbedoIntentResponseEnvelopeSchema.safeParse(msg).success
}

export function isAlbedoUserRejection(msg: unknown): boolean {
  const result = AlbedoIntentResponseEnvelopeSchema.safeParse(msg)
  return (
    result.success &&
    result.data.albedoIntentResult.status === 'rejected' &&
    result.data.albedoIntentResult.code === -4
  )
}

// ---------------------------------------------------------------------------
// Drift-check entry point for e2e/real/*.spec.ts
// ---------------------------------------------------------------------------

export type DriftCheckResult =
  | {
      ok: true
      matched: 'freighterRequest' | 'freighterResponse' | 'albedoRequest' | 'albedoResponse'
    }
  | { ok: false; reason: string; issues?: string }

function describeIssues(result: z.ZodSafeParseResult<unknown>): string | undefined {
  if (result.success) return undefined
  return result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
}

/**
 * Checks a captured real-wallet message against every known contract. Used
 * by the real-wallet e2e tests to turn "we captured something" into "we
 * captured something that still matches what we assumed" — the actual
 * drift signal.
 */
export function checkAgainstKnownContracts(msg: unknown): DriftCheckResult {
  const freighterReq = FreighterSubmitTransactionRequestSchema.safeParse(msg)
  if (freighterReq.success) return { ok: true, matched: 'freighterRequest' }

  const freighterRes = FreighterSubmitTransactionResponseSchema.safeParse(msg)
  if (freighterRes.success) return { ok: true, matched: 'freighterResponse' }

  const albedoReq = AlbedoIntentRequestSchema.safeParse(msg)
  if (albedoReq.success) return { ok: true, matched: 'albedoRequest' }

  const albedoRes = AlbedoIntentResponseEnvelopeSchema.safeParse(msg)
  if (albedoRes.success) return { ok: true, matched: 'albedoResponse' }

  return {
    ok: false,
    reason:
      'Captured message did not match any known Freighter or Albedo contract shape. ' +
      'This is either genuine protocol drift, or a new message type this file has ' +
      'not been taught about yet — do not assume which without checking.',
    issues: [
      describeIssues(freighterReq),
      describeIssues(freighterRes),
      describeIssues(albedoReq),
      describeIssues(albedoRes),
    ]
      .filter(Boolean)
      .join(' | '),
  }
}
