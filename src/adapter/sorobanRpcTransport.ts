import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  rpc,
  scValToNative,
} from '@stellar/stellar-sdk'
import type { SorobanRpcTransport, SorobanScoreRequest } from 'grydlock-oracle-adapter'

/**
 * Read-only simulation source. Simulation never submits or signs; the SDK's
 * own contract client uses this same all-zero account for read calls.
 */
const NULL_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'

/**
 * Interface version this transport speaks. There is no deployed, ratified
 * oracle contract yet (grydlock-oracle-adapter ADR 0001), so the wire
 * mapping below is this extension's working assumption:
 *
 *   get_score(destination: Address) -> u32            // scored, 0..=100
 *                                     | Unscored | Pending  // unit enum variant / symbol
 *
 * Anything else is passed through unchanged and rejected by
 * SorobanOracle's response validation, so a contract with a different
 * shape fails closed as "assessment unavailable".
 */
export const TRANSPORT_INTERFACE_VERSION = 1

/** The subset of rpc.Server this transport uses; injectable for tests. */
export interface SorobanRpcClient {
  getNetwork(): Promise<{ passphrase: string }>
  getLatestLedger(): Promise<{ sequence: number; closeTime: string }>
  simulateTransaction(
    tx: ReturnType<TransactionBuilder['build']>,
  ): Promise<rpc.Api.SimulateTransactionResponse>
}

function destinationArg(request: SorobanScoreRequest) {
  const { destination } = request
  if (destination.kind === 'account' || destination.kind === 'muxedAccount' || destination.kind === 'contract') {
    return new Address(destination.canonical).toScVal()
  }
  // Only account targets reach the oracle today; assets/pools need an agreed encoding.
  throw new Error(`Soroban oracle transport: unsupported destination kind ${destination.kind}`)
}

function decodeOutcome(native: unknown): unknown {
  if (typeof native === 'number' || typeof native === 'bigint') {
    return { variant: 'scored', score: Number(native) }
  }
  const tag = Array.isArray(native) && native.length === 1 ? native[0] : native
  if (typeof tag === 'string') {
    const variant = tag.toLowerCase()
    if (variant === 'unscored' || variant === 'pending') return { variant }
  }
  return native
}

export class SorobanRpcLiveTransport implements SorobanRpcTransport {
  readonly transportKind = 'live' as const
  private readonly client: SorobanRpcClient

  constructor(
    private readonly options: { rpcUrl: string; contractId: string; client?: SorobanRpcClient },
  ) {
    this.client =
      options.client ??
      new rpc.Server(options.rpcUrl, { allowHttp: new URL(options.rpcUrl).protocol === 'http:' })
  }

  async invokeGetScore(
    request: SorobanScoreRequest,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown> {
    options.signal?.throwIfAborted()
    const [network, latest] = await Promise.all([
      this.client.getNetwork(),
      this.client.getLatestLedger(),
    ])
    options.signal?.throwIfAborted()

    const tx = new TransactionBuilder(new Account(NULL_ACCOUNT, '0'), {
      fee: BASE_FEE,
      networkPassphrase: network.passphrase,
    })
      .addOperation(new Contract(this.options.contractId).call(request.method, destinationArg(request)))
      .setTimeout(30)
      .build()

    const simulation = await this.client.simulateTransaction(tx)
    options.signal?.throwIfAborted()
    if (rpc.Api.isSimulationError(simulation)) {
      throw new Error(`Soroban oracle rpc simulation failed: ${simulation.error}`)
    }
    const retval = simulation.result?.retval
    if (!retval) throw new Error('Soroban oracle rpc simulation returned no value')

    const sequence = simulation.latestLedger
    return {
      interfaceVersion: TRANSPORT_INTERFACE_VERSION,
      // Reported by the RPC node itself, so SorobanOracle's WrongNetworkError
      // check compares the configured network against the node's real one.
      networkPassphrase: network.passphrase,
      contractId: this.options.contractId,
      ledger: {
        sequence,
        closeTimeUnixMs: Number(latest.closeTime) * 1000,
        latestSeenSequence: Math.max(sequence, latest.sequence),
      },
      outcome: decodeOutcome(scValToNative(retval)),
    }
  }
}
