import { Asset, FeeBumpTransaction, Networks, TransactionBuilder } from '@stellar/stellar-sdk'

export interface DecodedDestination {
  destination: string
  asset?: string
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

const NETWORK_MAP: Record<string, string> = {
  PUBLIC: Networks.PUBLIC,
  TESTNET: Networks.TESTNET,
  FUTURENET: Networks.FUTURENET,
  SANDBOX: Networks.SANDBOX,
}

export function resolveNetworkPassphrase(networkOrPassphrase: string = Networks.PUBLIC): string {
  return NETWORK_MAP[networkOrPassphrase.toUpperCase()] ?? networkOrPassphrase
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
  networkPassphrase: string = Networks.PUBLIC,
): DecodedDestination | null {
  let parsed
  try {
    parsed = TransactionBuilder.fromXDR(xdr, resolveNetworkPassphrase(networkPassphrase))
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

  return { destination: [...destinations][0], asset }
}
