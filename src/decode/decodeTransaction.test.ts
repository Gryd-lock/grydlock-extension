// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk'
import { extractDestination } from './decodeTransaction'

const SOURCE = Keypair.random().publicKey()
const DEST_A = Keypair.random().publicKey()
const DEST_B = Keypair.random().publicKey()
const ISSUER = Keypair.random().publicKey()

function buildXdr(
  operations: ReturnType<typeof Operation.payment>[],
  networkPassphrase: string = Networks.TESTNET,
) {
  const account = new Account(SOURCE, '0')
  const builder = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase,
  })
  for (const op of operations) builder.addOperation(op)
  return builder.setTimeout(30).build().toXDR()
}

describe('extractDestination', () => {
  it('extracts destination for Networks.PUBLIC transactions by default and explicitly', () => {
    const xdr = buildXdr(
      [Operation.payment({ destination: DEST_A, asset: Asset.native(), amount: '10' })],
      Networks.PUBLIC,
    )
    expect(extractDestination(xdr)).toEqual({ destination: DEST_A, asset: undefined })
    expect(extractDestination(xdr, Networks.PUBLIC)).toEqual({ destination: DEST_A, asset: undefined })
    expect(extractDestination(xdr, 'PUBLIC')).toEqual({ destination: DEST_A, asset: undefined })
  })

  it('extracts destination for Networks.TESTNET transactions when specified', () => {
    const xdr = buildXdr(
      [Operation.payment({ destination: DEST_A, asset: Asset.native(), amount: '10' })],
      Networks.TESTNET,
    )
    expect(extractDestination(xdr, Networks.TESTNET)).toEqual({ destination: DEST_A, asset: undefined })
    expect(extractDestination(xdr, 'TESTNET')).toEqual({ destination: DEST_A, asset: undefined })
  })

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
})
