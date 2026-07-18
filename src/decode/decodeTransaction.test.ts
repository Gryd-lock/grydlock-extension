// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Account, Asset, Claimant, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk'
import { extractDestination } from './decodeTransaction'

const SOURCE = Keypair.random().publicKey()
const DEST_A = Keypair.random().publicKey()
const DEST_B = Keypair.random().publicKey()
const ISSUER = Keypair.random().publicKey()
const BALANCE_ID = '00000000da0d57da7d4850e7fc10d2a9d0ebc731f7afb40574c03395b17d49149b91f5be'

function buildXdr(operations: ReturnType<typeof Operation.payment>[]) {
  const account = new Account(SOURCE, '0')
  const builder = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
  for (const op of operations) builder.addOperation(op)
  return builder.setTimeout(30).build().toXDR()
}

describe('extractDestination', () => {
  it('extracts the destination from a single native payment', () => {
    const xdr = buildXdr([Operation.payment({ destination: DEST_A, asset: Asset.native(), amount: '10' })])
    expect(extractDestination(xdr, Networks.TESTNET)).toEqual({ destination: DEST_A, asset: undefined })
  })

  it('extracts destination and asset label from a non-native payment', () => {
    const credit = new Asset('USD', ISSUER)
    const xdr = buildXdr([Operation.payment({ destination: DEST_A, asset: credit, amount: '10' })])
    expect(extractDestination(xdr, Networks.TESTNET)).toEqual({
      destination: DEST_A,
      asset: `USD:${ISSUER}`,
    })
  })

  it('extracts the destination from a path payment', () => {
    const xdr = buildXdr([
      Operation.pathPaymentStrictSend({
        sendAsset: Asset.native(),
        sendAmount: '10',
        destination: DEST_A,
        destAsset: Asset.native(),
        destMin: '1',
        path: [],
      }),
    ])
    expect(extractDestination(xdr, Networks.TESTNET)).toEqual({ destination: DEST_A, asset: undefined })
  })

  it('returns null when operations target more than one destination', () => {
    const xdr = buildXdr([
      Operation.payment({ destination: DEST_A, asset: Asset.native(), amount: '10' }),
      Operation.payment({ destination: DEST_B, asset: Asset.native(), amount: '5' }),
    ])
    expect(extractDestination(xdr, Networks.TESTNET)).toBeNull()
  })

  it('resolves a single destination when repeated across operations', () => {
    const xdr = buildXdr([
      Operation.payment({ destination: DEST_A, asset: Asset.native(), amount: '10' }),
      Operation.payment({ destination: DEST_A, asset: Asset.native(), amount: '5' }),
    ])
    expect(extractDestination(xdr, Networks.TESTNET)).toEqual({ destination: DEST_A, asset: undefined })
  })

  it('returns null for operations with no destination (e.g. manageData)', () => {
    const xdr = buildXdr([Operation.manageData({ name: 'note', value: 'hi' })])
    expect(extractDestination(xdr, Networks.TESTNET)).toBeNull()
  })

  it('returns null for malformed XDR instead of throwing', () => {
    expect(extractDestination('not-valid-xdr', Networks.TESTNET)).toBeNull()
  })

  it('extracts the single claimant of a createClaimableBalance as the destination', () => {
    const xdr = buildXdr([
      Operation.createClaimableBalance({
        asset: Asset.native(),
        amount: '10',
        claimants: [new Claimant(DEST_A, Claimant.predicateUnconditional())],
      }),
    ])
    expect(extractDestination(xdr, Networks.TESTNET)).toEqual({ destination: DEST_A, asset: undefined })
  })

  it('extracts the asset label from a non-native createClaimableBalance', () => {
    const credit = new Asset('USD', ISSUER)
    const xdr = buildXdr([
      Operation.createClaimableBalance({
        asset: credit,
        amount: '10',
        claimants: [new Claimant(DEST_A, Claimant.predicateUnconditional())],
      }),
    ])
    expect(extractDestination(xdr, Networks.TESTNET)).toEqual({ destination: DEST_A, asset: `USD:${ISSUER}` })
  })

  it('returns null for a createClaimableBalance with multiple claimants', () => {
    const xdr = buildXdr([
      Operation.createClaimableBalance({
        asset: Asset.native(),
        amount: '10',
        claimants: [
          new Claimant(DEST_A, Claimant.predicateUnconditional()),
          new Claimant(DEST_B, Claimant.predicateUnconditional()),
        ],
      }),
    ])
    expect(extractDestination(xdr, Networks.TESTNET)).toBeNull()
  })

  it('resolves a single destination when the same claimant repeats across claimable balances', () => {
    const xdr = buildXdr([
      Operation.createClaimableBalance({
        asset: Asset.native(),
        amount: '10',
        claimants: [new Claimant(DEST_A, Claimant.predicateUnconditional())],
      }),
      Operation.createClaimableBalance({
        asset: Asset.native(),
        amount: '5',
        claimants: [new Claimant(DEST_A, Claimant.predicateUnconditional())],
      }),
    ])
    expect(extractDestination(xdr, Networks.TESTNET)).toEqual({ destination: DEST_A, asset: undefined })
  })

  it('extracts the balance ID from a claimClaimableBalance as the scoreable destination', () => {
    const xdr = buildXdr([Operation.claimClaimableBalance({ balanceId: BALANCE_ID })])
    expect(extractDestination(xdr, Networks.TESTNET)).toEqual({ destination: BALANCE_ID, asset: undefined })
  })

  it('returns null when a claim and a payment target different destinations', () => {
    const xdr = buildXdr([
      Operation.claimClaimableBalance({ balanceId: BALANCE_ID }),
      Operation.payment({ destination: DEST_A, asset: Asset.native(), amount: '10' }),
    ])
    expect(extractDestination(xdr, Networks.TESTNET)).toBeNull()
  })
})
