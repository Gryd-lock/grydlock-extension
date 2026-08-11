import { Asset, FeeBumpTransaction, Networks, TransactionBuilder } from '@stellar/stellar-sdk'
import type { Memo as MemoType, OperationRecord, Transaction } from '@stellar/stellar-sdk'

export interface DecodedDestination {
  destination: string
  asset?: string
}

export interface DecodedBatch {
  destinations: DecodedDestination[]
  memo?: { type: string; value: string }
}

interface OperationDestinations {
  destinations: string[]
  asset?: string
}

const NETWORK_MAP: Record<string, string> = {
  PUBLIC: Networks.PUBLIC,
  TESTNET: Networks.TESTNET,
  FUTURENET: Networks.FUTURENET,
  SANDBOX: Networks.SANDBOX,
}

function assetLabel(asset: Asset | undefined): string | undefined {
  if (!asset || asset.isNative()) return undefined
  return `${asset.getCode()}:${asset.getIssuer()}`
}

export function resolveNetworkPassphrase(networkOrPassphrase: string = Networks.PUBLIC): string {
  return NETWORK_MAP[networkOrPassphrase.toUpperCase()] ?? networkOrPassphrase
}

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

function memoValue(memo: MemoType): DecodedBatch['memo'] {
  switch (memo.type) {
    case 'text':
      return memo.value === null ? undefined : { type: 'text', value: memo.value.toString() }
    case 'id':
      return memo.value === null ? undefined : { type: 'id', value: memo.value.toString() }
    case 'hash':
      return memo.value === null ? undefined : { type: 'hash', value: Buffer.from(memo.value).toString('hex') }
    case 'return':
      return memo.value === null ? undefined : { type: 'return', value: Buffer.from(memo.value).toString('hex') }
    default:
      return undefined
  }
}

function mergeDestination(seen: Map<string, string | undefined>, destination: string, asset?: string) {
  const existing = seen.get(destination)
  if (!seen.has(destination) || (!existing && asset)) {
    seen.set(destination, asset)
  }
}

export function extractDecodedDestination(tx: Pick<Transaction, 'operations' | 'memo'>): DecodedBatch | null {
  const seen = new Map<string, string | undefined>()

  for (const op of tx.operations) {
    const resolved = destinationsFor(op)
    for (const destination of resolved.destinations) {
      mergeDestination(seen, destination, resolved.asset)
    }
  }

  if (seen.size === 0) return null

  return {
    destinations: Array.from(seen, ([destination, asset]) => ({ destination, asset })),
    memo: tx.memo ? memoValue(tx.memo) : undefined,
  }
}

export function extractDestination(
  xdr: string,
  networkPassphrase: string = Networks.TESTNET,
): DecodedBatch | null {
  try {
    const parsed = TransactionBuilder.fromXDR(xdr, resolveNetworkPassphrase(networkPassphrase))
    const tx = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed
    return extractDecodedDestination(tx)
  } catch {
    return null
  }
}
