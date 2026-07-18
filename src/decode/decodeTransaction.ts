import { Asset, FeeBumpTransaction, Networks, TransactionBuilder } from '@stellar/stellar-sdk'

export interface DecodedDestination {
  destination: string
  asset?: string
  memo?: { type: string; value: string }
}

const DESTINATION_OPERATION_TYPES = new Set([
  'payment',
  'pathPaymentStrictSend',
  'pathPaymentStrictReceive',
  'createAccount',
])

function assetLabel(op: Record<string, unknown>): string | undefined {
  const asset = (op.asset ?? op.destAsset) as Asset | undefined
  if (!asset || asset.isNative()) return undefined
  return `${asset.getCode()}:${asset.getIssuer()}`
}

/**
 * Extracts the single destination account an unsigned transaction pays to.
 * Returns null (never throws) when the XDR is malformed or the transaction
 * has no destination-bearing operation or more than one distinct destination
 * (e.g. a batch of payments to different accounts) — callers should treat
 * null as "can't determine a single destination to score."
 */
export function extractDestination(
  xdr: string,
  networkPassphrase: string = Networks.TESTNET,
): DecodedDestination | null {
  let parsed
  try {
    parsed = TransactionBuilder.fromXDR(xdr, networkPassphrase)
  } catch {
    return null
  }

  const tx = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed
  const destinations = new Set<string>()
  let asset: string | undefined

  for (const op of tx.operations) {
    if (DESTINATION_OPERATION_TYPES.has(op.type) && 'destination' in op && op.destination) {
      destinations.add(op.destination as string)
      asset = assetLabel(op as unknown as Record<string, unknown>)
    }
  }

  if (destinations.size !== 1) {
    return null
  }

  let memo: { type: string; value: string } | undefined
  if (tx.memo && tx.memo.type !== 'none') {
    const val = tx.memo.value
    let valueStr: string
    if (tx.memo.type === 'text' && Buffer.isBuffer(val)) {
      valueStr = val.toString('utf-8')
    } else if (Buffer.isBuffer(val)) {
      valueStr = val.toString('hex')
    } else {
      valueStr = String(val)
    }
    memo = { type: tx.memo.type, value: valueStr }
  }

  return { destination: [...destinations][0], asset, memo }
}
