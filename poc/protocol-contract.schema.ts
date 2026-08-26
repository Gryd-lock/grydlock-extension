/**
 * Protocol contract schemas — the source of truth Gryd Lock validates BOTH
 * its synthetic fixtures AND real captured wallet messages against.
 *
 * How this catches drift:
 *   - Synthetic fixtures validating here proves nothing new (internal consistency only).
 *   - A REAL captured message from an installed wallet failing here is the actual
 *     drift signal: the wallet no longer matches what Gryd Lock's code assumes.
 *
 * Update this file, with a reviewed diff, whenever a wallet version is deliberately
 * bumped (see spike §5 / §10). Do not loosen a poc just to make a failing
 * capture pass — that defeats the purpose; investigate the real change first.
 */
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Freighter: SUBMIT_TRANSACTION request (dApp -> extension, via window.postMessage)
// ---------------------------------------------------------------------------
export const FreighterSubmitTransactionRequest = z.object({
  source: z.literal('FREIGHTER_EXTERNAL_MSG_REQUEST'),
  type: z.literal('SUBMIT_TRANSACTION'),
  transactionXdr: z.string().min(1),
  networkPassphrase: z.string().min(1),
  // Optional fields seen in some releases — mark optional rather than omitting,
  // so a capture that INCLUDES them still validates, and we notice when a
  // previously-optional field becomes required (a breaking change) via §5's
  // golden-capture diff, not via this poc alone.
  accountToSign: z.string().optional(),
})
export type FreighterSubmitTransactionRequest = z.infer<typeof FreighterSubmitTransactionRequest>

// ---------------------------------------------------------------------------
// Freighter: response envelope (extension -> dApp)
// NOTE: exact shape must be captured from a real signing flow (§8 of the spike)
// and this poc tightened accordingly. The shape below is a starting point,
// not a verified contract — do not ship this unverified.
// ---------------------------------------------------------------------------
export const FreighterSubmitTransactionResponse = z
  .object({
    source: z.literal('FREIGHTER_EXTERNAL_MSG_RESPONSE'),
    type: z.literal('SUBMIT_TRANSACTION_RESPONSE'),
    signedTransaction: z.string().min(1).optional(),
    error: z.string().optional(),
  })
  .refine((msg) => msg.signedTransaction !== undefined || msg.error !== undefined, {
    message: 'Response must contain either signedTransaction or error',
  })

// ---------------------------------------------------------------------------
// Albedo: intent handshake (dApp opener -> albedo popup window, via postMessage)
// Albedo's real contract differs structurally from Freighter's: there is no
// ambient "external msg" broadcast on the page. The handshake only exists
// once the popup window is opened by albedo-intent. Model that here so a
// test can't accidentally assume Freighter-style ambient injection applies.
// ---------------------------------------------------------------------------
export const AlbedoIntentRequest = z.object({
  intent: z.enum(['tx', 'public_key', 'sign_message', 'implicit_flow', 'exchange']),
  network: z.enum(['public', 'testnet']).optional(),
  xdr: z.string().optional(),
  callback: z.string().url().optional(),
  submit: z.boolean().optional(),
})
export type AlbedoIntentRequest = z.infer<typeof AlbedoIntentRequest>

export const AlbedoIntentResponse = z.object({
  signed_envelope_xdr: z.string().optional(),
  tx_hash: z.string().optional(),
  pubkey: z.string().optional(),
  error: z.string().optional(),
})

// ---------------------------------------------------------------------------
// Validator helper used by both the synthetic test and the real-capture PoC.
// ---------------------------------------------------------------------------
export function validateOrReport<T>(
  schema: z.ZodType<T>,
  payload: unknown,
  label: string,
): { ok: true; data: T } | { ok: false; issues: string } {
  const result = schema.safeParse(payload)
  if (result.success) return { ok: true, data: result.data }
  return {
    ok: false,
    issues: `[${label}] protocol contract violation:\n${result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n')}`,
  }
}
