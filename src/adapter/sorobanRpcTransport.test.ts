// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { Networks, nativeToScVal, xdr, rpc } from '@stellar/stellar-sdk'
import {
  SOROBAN_ORACLE_INTERFACE_VERSION_RANGE,
  SorobanOracle,
  UnrecognizedDestinationError,
  WrongNetworkError,
} from 'grydlock-oracle-adapter'
import { SorobanRpcLiveTransport, type SorobanRpcClient } from './sorobanRpcTransport'

const CONTRACT = 'CAEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQTD2L'
const DEST = 'GCRNKXJJLZNDLK2EWPX25JISTORCXCF2HYUXMYKF7XWKHMEOHCXVGP4J'

function fakeClient(retval: xdr.ScVal | undefined, overrides: Partial<SorobanRpcClient> = {}) {
  const simulateTransaction = vi.fn(async () => ({
    id: '1',
    latestLedger: 1000,
    events: [],
    _parsed: true,
    transactionData: undefined,
    minResourceFee: '0',
    result: retval ? { auth: [], retval } : undefined,
  }) as unknown as rpc.Api.SimulateTransactionResponse)
  return {
    getNetwork: vi.fn(async () => ({ passphrase: Networks.TESTNET })),
    getLatestLedger: vi.fn(async () => ({ sequence: 1000, closeTime: String(Math.floor(Date.now() / 1000)) })),
    simulateTransaction,
    ...overrides,
  } satisfies SorobanRpcClient
}

function oracleWith(client: SorobanRpcClient, networkPassphrase = Networks.TESTNET) {
  return new SorobanOracle(
    {
      environment: 'production',
      networkPassphrase,
      rpcEndpoints: ['https://rpc.example'],
      contractId: CONTRACT,
      supportedInterfaceVersionRange: SOROBAN_ORACLE_INTERFACE_VERSION_RANGE,
      finalityPolicy: { minConfirmations: 0, maxResultAgeMs: 60_000 },
      requestBudgetMs: 1_000,
    },
    new SorobanRpcLiveTransport({ rpcUrl: 'https://rpc.example', contractId: CONTRACT, client }),
  )
}

describe('SorobanRpcLiveTransport through SorobanOracle', () => {
  it('simulates get_score(Address) on the configured contract and returns the u32 score', async () => {
    const client = fakeClient(nativeToScVal(55, { type: 'u32' }))
    await expect(oracleWith(client).getScore(DEST)).resolves.toBe(55)

    const tx = vi.mocked(client.simulateTransaction).mock.calls[0][0] as unknown as {
      operations: Array<{ func: xdr.HostFunction }>
    }
    const invoke = tx.operations[0].func.invokeContract()
    expect(invoke.functionName().toString()).toBe('get_score')
    expect(invoke.args()[0].switch().name).toBe('scvAddress')
  })

  it('maps an Unscored enum variant to the package unrecognized-destination error', async () => {
    const client = fakeClient(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Unscored')]))
    await expect(oracleWith(client).getScore(DEST)).rejects.toBeInstanceOf(UnrecognizedDestinationError)
  })

  it('rejects an RPC node on a different network than the request', async () => {
    const client = fakeClient(nativeToScVal(10, { type: 'u32' }), {
      getNetwork: vi.fn(async () => ({ passphrase: Networks.PUBLIC })),
    })
    await expect(oracleWith(client).getScore(DEST)).rejects.toBeInstanceOf(WrongNetworkError)
  })

  it('fails (never scores) when the contract returns an unexpected shape or simulation errors', async () => {
    await expect(oracleWith(fakeClient(nativeToScVal('hello'))).getScore(DEST)).rejects.toThrow()
    await expect(oracleWith(fakeClient(undefined)).getScore(DEST)).rejects.toThrow()
    const failing = fakeClient(undefined, {
      simulateTransaction: vi.fn(async () => ({ id: '1', latestLedger: 1, events: [], _parsed: true, error: 'HostError: contract not found' }) as unknown as rpc.Api.SimulateTransactionResponse),
    })
    await expect(oracleWith(failing).getScore(DEST)).rejects.toThrow()
  })
})
