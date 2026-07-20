import { describe, expect, it } from 'vitest'
import { Account, Asset, Claimant, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk'
import { extractDestination } from './decodeTransaction'

const SOURCE = Keypair.random().publicKey()
const DEST_A = Keypair.random().publicKey()
const DEST_B = Keypair.random().publicKey()
const ISSUER = Keypair.random().publicKey()
const BALANCE_ID = '00000000da0d57da7d4850e7fc10d2a9d0ebc731f7afb40574c03395b17d49149b91f5be'

function buildXdr(operations: ReturnType<typeof Operation.payment>[], memo?: Memo) {
  const account = new Account(SOURCE, '0')
  const builder = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase,
  })
  for (const op of operations) builder.addOperation(op)
  if (memo) builder.addMemo(memo)
  return builder.setTimeout(30).build().toXDR()
}

describe('extractDestination', () => {
  it('returns null for operations with no destination (e.g. manageData)', () => {
    const xdr = buildXdr([Operation.manageData({ name: 'note', value: 'hi' })])
    expect(extractDestination(xdr, Networks.TESTNET)).toBeNull()
  })

  it('returns null for malformed XDR instead of throwing', () => {
    expect(extractDestination('not-valid-xdr', Networks.TESTNET)).toBeNull()
  })

  it('extracts a single destination from a single native payment', () => {
    const xdr = buildXdr([
      Operation.payment({ destination: DEST_A, asset: Asset.native(), amount: '10' }),
    ])
    expect(extractDestination(xdr, Networks.TESTNET)).toEqual({
      destinations: [{ destination: DEST_A, asset: undefined }],
    })
  })

  it('extracts one destination and its asset label from a non-native payment', () => {
    const credit = new Asset('USD', ISSUER)
    const xdr = buildXdr([
      Operation.payment({ destination: DEST_A, asset: credit, amount: '10' }),
    ])
    expect(extractDestination(xdr, Networks.TESTNET)).toEqual({
      destinations: [{ destination: DEST_A, asset: `USD:${ISSUER}` }],
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
    expect(extractDestination(xdr, Networks.TESTNET)).toEqual({
      destinations: [{ destination: DEST_A, asset: undefined }],
    })
  })

  it('returns all distinct destinations when a transaction targets more than one', () => {
    const xdr = buildXdr([
      Operation.payment({ destination: DEST_A, asset: Asset.native(), amount: '10' }),
      Operation.payment({ destination: DEST_B, asset: Asset.native(), amount: '5' }),
    ])
    expect(extractDestination(xdr, Networks.TESTNET)).toEqual({
      destinations: [
        { destination: DEST_A, asset: undefined },
        { destination: DEST_B, asset: undefined },
      ],
    })
  })

  it('deduplicates repeated destinations while preserving asset labels', () => {
    const credit = new Asset('USD', ISSUER)
    const xdr = buildXdr([
      Operation.payment({ destination: DEST_A, asset: Asset.native(), amount: '10' }),
      Operation.payment({ destination: DEST_A, asset: credit, amount: '5' }),
    ])
    expect(extractDestination(xdr, Networks.TESTNET)).toEqual({
      destinations: [{ destination: DEST_A, asset: `USD:${ISSUER}` }],
    })
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

  it('handles transactions with extreme operation counts (e.g. 50 operations)', () => {
    const ops = Array.from({ length: 50 }, () =>
      Operation.payment({ destination: DEST_A, asset: Asset.native(), amount: '1' }),
    )
    const xdr = buildXdr(ops)
    expect(extractDestination(xdr, Networks.TESTNET)).toEqual({ destination: DEST_A, asset: undefined })
  })

  it('handles deeply nested path payments with many path assets', () => {
    const path = Array.from({ length: 5 }, () => new Asset('OPT', ISSUER))
    const xdr = buildXdr([
      Operation.pathPaymentStrictSend({
        sendAsset: Asset.native(),
        sendAmount: '100',
        destination: DEST_A,
        destAsset: new Asset('USD', ISSUER),
        destMin: '1',
        path,
      }),
    ])
    expect(extractDestination(xdr, Networks.TESTNET)).toEqual({
      destination: DEST_A,
      asset: `USD:${ISSUER}`,
    })
  })

  describe('property-based fuzzing & defensive resilience', () => {
    it('never throws on arbitrary random strings', () => {
      fc.assert(
        fc.property(fc.string(), (randomStr) => {
          expect(() => extractDestination(randomStr)).not.toThrow()
          expect(extractDestination(randomStr)).toBeNull()
        }),
        { numRuns: 100 },
      )
    })

    it('never throws on arbitrary base64/binary payloads', () => {
      fc.assert(
        fc.property(fc.base64String(), (base64Payload) => {
          expect(() => extractDestination(base64Payload)).not.toThrow()
        }),
        { numRuns: 100 },
      )
    })

    it('never throws and correctly identifies single vs multiple destinations on generated valid transactions', () => {
      const validPubkeyArb = fc
        .uint8Array({ minLength: 32, maxLength: 32 })
        .map((seed) => Keypair.fromRawEd25519Seed(Buffer.from(seed)).publicKey())

      const assetArb = fc.oneof(
        fc.constant(Asset.native()),
        fc.tuple(fc.stringMatching(/^[A-Za-z0-9]{1,12}$/), validPubkeyArb).map(([code, issuer]) => new Asset(code, issuer)),
      )

      type TestOp = {
        dest: string | null
        op: ReturnType<typeof Operation.payment>
      }

      const opArb: fc.Arbitrary<TestOp> = fc.oneof(
        // payment
        fc.tuple(validPubkeyArb, assetArb, fc.integer({ min: 1, max: 1000000 })).map(([dest, asset, amount]) => ({
          dest,
          op: Operation.payment({ destination: dest, asset, amount: amount.toString() }),
        })),
        // pathPaymentStrictSend
        fc
          .tuple(
            validPubkeyArb,
            assetArb,
            assetArb,
            fc.array(assetArb, { maxLength: 5 }),
            fc.integer({ min: 1, max: 1000000 }),
          )
          .map(([dest, sendAsset, destAsset, path, amount]) => ({
            dest,
            op: Operation.pathPaymentStrictSend({
              destination: dest,
              sendAsset,
              sendAmount: amount.toString(),
              destAsset,
              destMin: '1',
              path,
            }),
          })),
        // pathPaymentStrictReceive
        fc
          .tuple(
            validPubkeyArb,
            assetArb,
            assetArb,
            fc.array(assetArb, { maxLength: 5 }),
            fc.integer({ min: 1, max: 1000000 }),
          )
          .map(([dest, sendAsset, destAsset, path, amount]) => ({
            dest,
            op: Operation.pathPaymentStrictReceive({
              destination: dest,
              sendAsset,
              sendMax: '1000000',
              destAsset,
              destAmount: amount.toString(),
              path,
            }),
          })),
        // createAccount
        fc
          .tuple(validPubkeyArb, fc.integer({ min: 1, max: 1000000 }))
          .map(([dest, amount]) => ({
            dest,
            op: Operation.createAccount({ destination: dest, startingBalance: amount.toString() }),
          })),
        // manageData (non-destination op)
        fc
          .stringMatching(/^[a-zA-Z0-9_]{1,16}$/)
          .map((name) => ({
            dest: null,
            op: Operation.manageData({ name, value: 'data' }),
          })),
      )

      fc.assert(
        fc.property(
          fc.array(opArb, { minLength: 1, maxLength: 25 }),
          (testOps) => {
            const xdr = buildXdr(testOps.map((t) => t.op))
            let result: DecodedDestination | null = null
            expect(() => {
              result = extractDestination(xdr, Networks.TESTNET)
            }).not.toThrow()

            const expectedDests = new Set<string>()
            for (const t of testOps) {
              if (t.dest) {
                expectedDests.add(t.dest)
              }
            }

            if (expectedDests.size === 1) {
              const res = result as DecodedDestination | null
              expect(res).not.toBeNull()
              expect(res?.destination).toBe([...expectedDests][0])
            } else {
              expect(result).toBeNull()
            }
          },
        ),
        { numRuns: 100 },
      )
    })
  })

  describe('memo extraction', () => {
    it('returns undefined memo when none is present', () => {
      const xdr = buildXdr([Operation.payment({ destination: DEST_A, asset: Asset.native(), amount: '10' })])
      expect(extractDestination(xdr, Networks.TESTNET)?.memo).toBeUndefined()
    })

    it('extracts a text memo', () => {
      const xdr = buildXdr([Operation.payment({ destination: DEST_A, asset: Asset.native(), amount: '10' })], Memo.text('hello'))
      expect(extractDestination(xdr, Networks.TESTNET)?.memo).toEqual({ type: 'text', value: 'hello' })
    })

    it('extracts an id memo', () => {
      const xdr = buildXdr([Operation.payment({ destination: DEST_A, asset: Asset.native(), amount: '10' })], Memo.id('12345'))
      expect(extractDestination(xdr, Networks.TESTNET)?.memo).toEqual({ type: 'id', value: '12345' })
    })

    it('extracts a hash memo as hex string', () => {
      const hashHex = '0000000000000000000000000000000000000000000000000000000000000000'
      const xdr = buildXdr([Operation.payment({ destination: DEST_A, asset: Asset.native(), amount: '10' })], Memo.hash(hashHex))
      expect(extractDestination(xdr, Networks.TESTNET)?.memo).toEqual({ type: 'hash', value: hashHex })
    })

    it('extracts a return memo as hex string', () => {
      const returnHex = '1111111111111111111111111111111111111111111111111111111111111111'
      const xdr = buildXdr([Operation.payment({ destination: DEST_A, asset: Asset.native(), amount: '10' })], Memo.return(returnHex))
      expect(extractDestination(xdr, Networks.TESTNET)?.memo).toEqual({ type: 'return', value: returnHex })
    })
  })
})

describe('extractDecodedDestination', () => {
  it('extracts contract address and function from invokeContract operations', () => {
    const fakeTx = {
      operations: [
        {
          type: 'invokeHostFunction',
          hostFunction: {
            functions: [
              {
                type: 'invokeContract',
                invokeContract: {
                  contractAddress: DEST_A,
                  functionName: 'transfer',
                  args: [] as never[],
                },
              },
            ],
          },
        },
      ],
    }
    expect(extractDecodedDestination(fakeTx)).toEqual({
      kind: 'contractInvocation',
      destination: DEST_A,
      function: 'transfer',
    })
  })

  it('returns null when invokeHostFunction has no invokeContract function', () => {
    const fakeTx = {
      operations: [
        {
          type: 'invokeHostFunction',
          hostFunction: {
            functions: [
              { type: 'uploadContractWasm', uploadContractWasm: { wasm: 'abc-wasm' } },
            ],
          },
        },
      ],
    }
    expect(extractDecodedDestination(fakeTx)).toBeNull()
  })

  it('returns null when invokeContract provides no contractAddress', () => {
    const fakeTx = {
      operations: [
        {
          type: 'invokeHostFunction',
          hostFunction: {
            functions: [
              {
                type: 'invokeContract',
                invokeContract: {
                  functionName: 'transfer',
                  args: [] as never[],
                },
              },
            ],
          },
        },
      ],
    }
    expect(extractDecodedDestination(fakeTx)).toBeNull()
  })

  it('returns null when multiple distinct contract destinations appear', () => {
    const fakeTx = {
      operations: [
        {
          type: 'invokeHostFunction',
          hostFunction: {
            functions: [
              {
                type: 'invokeContract',
                invokeContract: { contractAddress: DEST_A, functionName: 'transfer', args: [] as never[] },
              },
            ],
          },
        },
        {
          type: 'invokeHostFunction',
          hostFunction: {
            functions: [
              {
                type: 'invokeContract',
                invokeContract: { contractAddress: DEST_B, functionName: 'approve', args: [] as never[] },
              },
            ],
          },
        },
      ],
    }
    expect(extractDecodedDestination(fakeTx)).toBeNull()
  })
})
