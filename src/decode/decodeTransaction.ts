import { Asset, FeeBumpTransaction, Networks, TransactionBuilder } from '@stellar/stellar-sdk'

export interface DecodedDestination {
  destination: string
  asset?: string
}

export interface DecodedBatch {
  destinations: DecodedDestination[]
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
 * Extracts every distinct destination account an unsigned transaction pays to.
 *
 * Returns null (never throws) when the XDR is malformed or there are no
 * destination-bearing operations. Previously this returned null when there was
 * more than one distinct destination, which made multi-destination batches
 * indistinguishable from "can't parse" and caused resolveOutcome to silently
 * 'allow' them. Callers are expected to handle a batch of destinations.
 */
export function extractDestination(
  xdr: string,
  networkPassphrase: string = Networks.TESTNET,
): DecodedBatch | null {
  let parsed
  try {
    parsed = TransactionBuilder.fromXDR(xdr, networkPassphrase)
  } catch {
    return null
  }

  const tx = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed
  const seen = new Map<string, string>()

  for (const op of tx.operations) {
    if (DESTINATION_OPERATION_TYPES.has(op.type) && 'destination' in op && op.destination) {
      const destination = op.destination as string
      const asset = assetLabel(op as unknown as Record<string, unknown>)
      if (!seen.has(destination)) {
        seen.set(destination, asset ?? '')
      } else if (asset && !seen.get(destination)) {
        seen.set(destination, asset)
      }
    }
  }

  if (seen.size === 0) {
    return null
  }

  return {
    destinations: [...seen.entries()].map(([destination, asset]) => ({
      destination,
      asset: asset || undefined,
    })),
  }
}
