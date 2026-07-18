import { Asset, FeeBumpTransaction, Networks, TransactionBuilder } from '@stellar/stellar-sdk'
import type { OperationRecord } from '@stellar/stellar-sdk'

export interface DecodedDestination {
  destination: string
  asset?: string
}

interface OperationDestinations {
  destinations: string[]
  asset?: string
}

function assetLabel(asset: Asset | undefined): string | undefined {
  if (!asset || asset.isNative()) return undefined
  return `${asset.getCode()}:${asset.getIssuer()}`
}

/**
 * Maps a single operation to the destination(s) it pays or transfers value
 * to. createClaimableBalance yields one candidate destination per claimant,
 * since any of them may go on to claim the balance. claimClaimableBalance
 * carries no destination account in the operation itself — only an opaque
 * balance ID — so the ID is used as the scoreable identifier instead.
 */
function destinationsFor(op: OperationRecord): OperationDestinations {
  switch (op.type) {
    case 'payment':
      return { destinations: [op.destination], asset: assetLabel(op.asset) }
    case 'pathPaymentStrictSend':
    case 'pathPaymentStrictReceive':
      return { destinations: [op.destination], asset: assetLabel(op.destAsset) }
    case 'createAccount':
      return { destinations: [op.destination] }
    case 'createClaimableBalance':
      return {
        destinations: op.claimants.map((claimant) => claimant.destination),
        asset: assetLabel(op.asset),
      }
    case 'claimClaimableBalance':
      return { destinations: [op.balanceId] }
    default:
      return { destinations: [] }
  }
}

/**
 * Extracts the single destination an unsigned transaction pays or transfers
 * value to. Returns null (never throws) when the XDR is malformed, the
 * transaction has no destination-bearing operation, or it resolves to more
 * than one distinct destination — e.g. a batch of payments to different
 * accounts, or a createClaimableBalance with multiple claimants. Callers
 * should treat null as "can't determine a single destination to score."
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
    const resolved = destinationsFor(op)
    if (resolved.destinations.length === 0) continue
    for (const destination of resolved.destinations) destinations.add(destination)
    asset = resolved.asset
  }

  if (destinations.size !== 1) {
    return null
  }

  return { destination: [...destinations][0], asset }
}
