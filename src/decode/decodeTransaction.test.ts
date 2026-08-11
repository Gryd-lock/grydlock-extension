import { Account, Asset, Claimant, Memo, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'
import { extractDestination, resolveNetworkPassphrase } from './decodeTransaction'

const SOURCE = 'GDR2Q6FLC4L277PFRHOB7OVKDZFURPSU3NVOK5TYB2Q5CVBWH345DLU5'
const DEST_A = 'GAJBUZ24T66NRCSFEBVRMDU3HC7PQPVORDX6NHD3CWJNMEJEF5TMMR2Z'
const DEST_B = 'GD6CHB2GF6Q5OIYH4RDQIMHF27CWI3RC42KP3NEUJ6TNWG4KPJD5SZY7'
const ISSUER = 'GBQ643CLEU2HQDIU6SCFPAHMULF6WDMULUU6RPNLWRNHXDDU76GH7MQK'
const BALANCE_ID = '00000000da0d57da7d4850e7fc10d2a9d0ebc731f7afb40574c03395b17d49149b91f5be'

type TestOperation = Parameters<TransactionBuilder['addOperation']>[0]

function buildXdr(operations: TestOperation[], memo?: Memo) {
  const account = new Account(SOURCE, '0')
  const builder = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
  for (const op of operations) builder.addOperation(op)
  if (memo) builder.addMemo(memo)
  return builder.setTimeout(30).build().toXDR()
}

describe('resolveNetworkPassphrase', () => {
  it('maps known aliases to Stellar network passphrases', () => {
    expect(resolveNetworkPassphrase('TESTNET')).toBe(Networks.TESTNET)
    expect(resolveNetworkPassphrase('public')).toBe(Networks.PUBLIC)
  })

  it('returns custom passphrases unchanged', () => {
    expect(resolveNetworkPassphrase('Custom Network ; 2030')).toBe('Custom Network ; 2030')
  })
})

describe('extractDestination', () => {
  it('returns null for operations with no destination', () => {
    const xdr = buildXdr([Operation.manageData({ name: 'note', value: 'hi' })])
    expect(extractDestination(xdr, Networks.TESTNET)).toBeNull()
  })

  it('returns null for malformed XDR instead of throwing', () => {
    expect(extractDestination('not-valid-xdr', Networks.TESTNET)).toBeNull()
  })

  it('extracts a single native payment destination', () => {
    const xdr = buildXdr([
      Operation.payment({ destination: DEST_A, asset: Asset.native(), amount: '10' }),
    ])
    expect(extractDestination(xdr, Networks.TESTNET)).toEqual({
      destinations: [{ destination: DEST_A, asset: undefined }],
      memo: undefined,
    })
  })

  it('extracts an asset label from a non-native payment', () => {
    const credit = new Asset('USD', ISSUER)
    const xdr = buildXdr([
      Operation.payment({ destination: DEST_A, asset: credit, amount: '10' }),
    ])
    expect(extractDestination(xdr, Networks.TESTNET)).toEqual({
      destinations: [{ destination: DEST_A, asset: `USD:${ISSUER}` }],
      memo: undefined,
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
    expect(extractDestination(xdr, Networks.TESTNET)?.destinations).toEqual([
      { destination: DEST_A, asset: undefined },
    ])
  })

  it('returns all distinct destinations in insertion order', () => {
    const xdr = buildXdr([
      Operation.payment({ destination: DEST_A, asset: Asset.native(), amount: '10' }),
      Operation.payment({ destination: DEST_B, asset: Asset.native(), amount: '5' }),
    ])
    expect(extractDestination(xdr, Networks.TESTNET)?.destinations).toEqual([
      { destination: DEST_A, asset: undefined },
      { destination: DEST_B, asset: undefined },
    ])
  })

  it('deduplicates repeated destinations while preserving the most specific asset label', () => {
    const credit = new Asset('USD', ISSUER)
    const xdr = buildXdr([
      Operation.payment({ destination: DEST_A, asset: Asset.native(), amount: '10' }),
      Operation.payment({ destination: DEST_A, asset: credit, amount: '5' }),
    ])
    expect(extractDestination(xdr, Networks.TESTNET)?.destinations).toEqual([
      { destination: DEST_A, asset: `USD:${ISSUER}` },
    ])
  })

  it('extracts claimable balance claimants as scoreable destinations', () => {
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
    expect(extractDestination(xdr, Networks.TESTNET)?.destinations).toEqual([
      { destination: DEST_A, asset: undefined },
      { destination: DEST_B, asset: undefined },
    ])
  })

  it('uses claimClaimableBalance IDs as scoreable destinations', () => {
    const xdr = buildXdr([Operation.claimClaimableBalance({ balanceId: BALANCE_ID })])
    expect(extractDestination(xdr, Networks.TESTNET)?.destinations).toEqual([
      { destination: BALANCE_ID, asset: undefined },
    ])
  })

  it('extracts text memos', () => {
    const xdr = buildXdr(
      [Operation.payment({ destination: DEST_A, asset: Asset.native(), amount: '10' })],
      Memo.text('hello'),
    )
    expect(extractDestination(xdr, Networks.TESTNET)?.memo).toEqual({
      type: 'text',
      value: 'hello',
    })
  })

  it('extracts id memos', () => {
    const xdr = buildXdr(
      [Operation.payment({ destination: DEST_A, asset: Asset.native(), amount: '10' })],
      Memo.id('12345'),
    )
    expect(extractDestination(xdr, Networks.TESTNET)?.memo).toEqual({
      type: 'id',
      value: '12345',
    })
  })
})
