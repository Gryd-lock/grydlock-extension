// @vitest-environment node
// The Stellar SDK hashes with @noble, which rejects jsdom's cross-realm Buffer
// when deriving asset contract ids; this suite is pure decoding and needs no DOM.
import {
  Account,
  Address,
  Asset,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'
import { extractSorobanSemantics } from './sorobanSemantics'

const SOURCE = 'GDR2Q6FLC4L277PFRHOB7OVKDZFURPSU3NVOK5TYB2Q5CVBWH345DLU5'
const HOLDER = 'GAJBUZ24T66NRCSFEBVRMDU3HC7PQPVORDX6NHD3CWJNMEJEF5TMMR2Z'
const RECIPIENT = 'GD6CHB2GF6Q5OIYH4RDQIMHF27CWI3RC42KP3NEUJ6TNWG4KPJD5SZY7'
const ISSUER = 'GBQ643CLEU2HQDIU6SCFPAHMULF6WDMULUU6RPNLWRNHXDDU76GH7MQK'

const USDC = new Asset('USDC', ISSUER)
const USDC_CONTRACT = USDC.contractId(Networks.TESTNET)
const NATIVE_CONTRACT = Asset.native().contractId(Networks.TESTNET)
const CUSTOM_CONTRACT = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE'

type TestOperation = Parameters<TransactionBuilder['addOperation']>[0]

const options = { networkPassphrase: Networks.TESTNET }

function buildXdr(operations: TestOperation[]) {
  const builder = new TransactionBuilder(new Account(SOURCE, '0'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
  for (const op of operations) builder.addOperation(op)
  return builder.setTimeout(30).build().toXDR()
}

function i128(value: bigint) {
  return nativeToScVal(value, { type: 'i128' })
}

function call(contractId: string, fn: string, ...args: xdr.ScVal[]) {
  return new Contract(contractId).call(fn, ...args)
}

function contractFn(contractId: string, fn: string, args: xdr.ScVal[] = []) {
  return xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(contractId).toScAddress(),
      functionName: fn,
      args,
    }),
  )
}

function authInvocation(
  contractId: string,
  fn: string,
  args: xdr.ScVal[] = [],
  subInvocations: xdr.SorobanAuthorizedInvocation[] = [],
) {
  return new xdr.SorobanAuthorizedInvocation({
    function: contractFn(contractId, fn, args),
    subInvocations,
  })
}

function sourceAuth(rootInvocation: xdr.SorobanAuthorizedInvocation) {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation,
  })
}

function addressAuth(
  signer: string,
  rootInvocation: xdr.SorobanAuthorizedInvocation,
  expiration = 100,
) {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(signer).toScAddress(),
        nonce: xdr.Int64.fromString('7'),
        signatureExpirationLedger: expiration,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation,
  })
}

function hostFn(contractId: string, fn: string, args: xdr.ScVal[] = []) {
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(contractId).toScAddress(),
      functionName: fn,
      args,
    }),
  )
}

function invokeWithAuth(func: xdr.HostFunction, auth: xdr.SorobanAuthorizationEntry[]) {
  return Operation.invokeHostFunction({ func, auth })
}

describe('extractSorobanSemantics', () => {
  it('ignores transactions without Soroban operations', () => {
    const xdrString = buildXdr([
      Operation.payment({ destination: RECIPIENT, asset: Asset.native(), amount: '1' }),
    ])
    expect(extractSorobanSemantics(xdrString, options)).toEqual([])
  })

  it('returns no semantics for XDR that cannot be parsed', () => {
    expect(extractSorobanSemantics('not-xdr', options)).toEqual([])
  })

  it('decodes a Stellar asset contract transfer into an inferred movement', () => {
    const xdrString = buildXdr([
      call(
        USDC_CONTRACT,
        'transfer',
        new Address(SOURCE).toScVal(),
        new Address(RECIPIENT).toScVal(),
        i128(25_000_000n),
      ),
    ])

    const [semantics] = extractSorobanSemantics(xdrString, {
      ...options,
      knownAssets: [{ code: 'USDC', issuer: ISSUER }],
    })

    expect(semantics.kind).toBe('invokeContract')
    expect(semantics.confidence).toBe('decoded')
    expect(semantics.invocation).toMatchObject({
      contractId: USDC_CONTRACT,
      functionName: 'transfer',
    })
    expect(semantics.invocation?.args.map((arg) => arg.type)).toEqual([
      'address',
      'address',
      'i128',
    ])
    expect(semantics.movements).toEqual([
      {
        kind: 'transfer',
        contractId: USDC_CONTRACT,
        asset: `USDC:${ISSUER}`,
        from: SOURCE,
        to: RECIPIENT,
        spender: undefined,
        amount: '25000000',
        decimals: 7,
        inferred: true,
      },
    ])
    expect(semantics.warnings).toEqual([])
    expect(semantics.accounts).toEqual([SOURCE, RECIPIENT])
    expect(semantics.contracts).toEqual([USDC_CONTRACT])
  })

  it('labels the native asset contract without caller-supplied assets', () => {
    const xdrString = buildXdr([
      call(
        NATIVE_CONTRACT,
        'transfer',
        new Address(SOURCE).toScVal(),
        new Address(RECIPIENT).toScVal(),
        i128(1n),
      ),
    ])

    const [semantics] = extractSorobanSemantics(xdrString, options)
    expect(semantics.movements[0]).toMatchObject({ asset: 'XLM', decimals: 7 })
  })

  it('leaves an unrecognised token contract unlabelled', () => {
    const xdrString = buildXdr([
      call(
        CUSTOM_CONTRACT,
        'transfer',
        new Address(SOURCE).toScVal(),
        new Address(RECIPIENT).toScVal(),
        i128(1n),
      ),
    ])

    const [semantics] = extractSorobanSemantics(xdrString, options)
    expect(semantics.movements[0].asset).toBeUndefined()
    expect(semantics.movements[0].decimals).toBeUndefined()
  })

  it('flags a transfer that spends from an account other than the transaction source', () => {
    const xdrString = buildXdr([
      call(
        USDC_CONTRACT,
        'transfer',
        new Address(HOLDER).toScVal(),
        new Address(RECIPIENT).toScVal(),
        i128(1n),
      ),
    ])

    const [semantics] = extractSorobanSemantics(xdrString, options)
    expect(semantics.warnings).toContain('third-party-transfer')
  })

  it('reports an unknown function as partially decoded', () => {
    const xdrString = buildXdr([
      call(CUSTOM_CONTRACT, 'swap_exact_in', nativeToScVal('pool', { type: 'symbol' }), i128(5n)),
    ])

    const [semantics] = extractSorobanSemantics(xdrString, options)
    expect(semantics.confidence).toBe('partial')
    expect(semantics.warnings).toContain('unknown-function')
    expect(semantics.movements).toEqual([])
    expect(semantics.invocation?.functionName).toBe('swap_exact_in')
  })

  it('flags an effectively unlimited, long-lived approval', () => {
    const xdrString = buildXdr([
      call(
        USDC_CONTRACT,
        'approve',
        new Address(SOURCE).toScVal(),
        new Address(RECIPIENT).toScVal(),
        i128(2n ** 120n),
        nativeToScVal(3_000_000, { type: 'u32' }),
      ),
    ])

    const [semantics] = extractSorobanSemantics(xdrString, options)
    expect(semantics.movements[0]).toMatchObject({ kind: 'approve', spender: RECIPIENT })
    expect(semantics.warnings).toContain('unbounded-approval')
    expect(semantics.warnings).toContain('long-lived-approval')
  })

  it('does not flag a bounded, short-lived approval', () => {
    const xdrString = buildXdr([
      call(
        USDC_CONTRACT,
        'approve',
        new Address(SOURCE).toScVal(),
        new Address(RECIPIENT).toScVal(),
        i128(10_000_000n),
        nativeToScVal(1_000, { type: 'u32' }),
      ),
    ])

    const [semantics] = extractSorobanSemantics(xdrString, options)
    expect(semantics.warnings).toEqual([])
  })

  it('flags token administration calls', () => {
    const xdrString = buildXdr([call(USDC_CONTRACT, 'set_admin', new Address(RECIPIENT).toScVal())])

    const [semantics] = extractSorobanSemantics(xdrString, options)
    expect(semantics.warnings).toContain('token-admin-operation')
    expect(semantics.movements).toEqual([])
  })

  it('surfaces authorised calls that the top-level invocation does not name', () => {
    const func = hostFn(CUSTOM_CONTRACT, 'deposit', [i128(1n)])
    const hidden = authInvocation(
      CUSTOM_CONTRACT,
      'deposit',
      [i128(1n)],
      [
        authInvocation(USDC_CONTRACT, 'transfer', [
          new Address(SOURCE).toScVal(),
          new Address(RECIPIENT).toScVal(),
          i128(999n),
        ]),
      ],
    )

    const xdrString = buildXdr([invokeWithAuth(func, [sourceAuth(hidden)])])
    const [semantics] = extractSorobanSemantics(xdrString, options)

    expect(semantics.warnings).toContain('hidden-authorization')
    expect(semantics.authorizations[0].credentials).toBe('sourceAccount')
    expect(semantics.authorizations[0].invocations.map((entry) => entry.functionName)).toEqual([
      'deposit',
      'transfer',
    ])
    expect(semantics.contracts).toEqual([CUSTOM_CONTRACT, USDC_CONTRACT])
  })

  it('flags authorisation signed by an address other than the transaction source', () => {
    const func = hostFn(CUSTOM_CONTRACT, 'deposit', [i128(1n)])
    const entry = addressAuth(HOLDER, authInvocation(CUSTOM_CONTRACT, 'deposit', [i128(1n)]), 4242)

    const xdrString = buildXdr([invokeWithAuth(func, [entry])])
    const [semantics] = extractSorobanSemantics(xdrString, options)

    expect(semantics.warnings).toContain('foreign-authorization')
    expect(semantics.authorizations[0]).toMatchObject({
      credentials: 'address',
      signer: HOLDER,
      signatureExpirationLedger: 4242,
    })
  })

  it('flags an authorisation tree deeper than the display limit without recursing through it', () => {
    let node = authInvocation(CUSTOM_CONTRACT, 'leaf')
    for (let level = 0; level < 6; level += 1) {
      node = authInvocation(CUSTOM_CONTRACT, `level_${level}`, [], [node])
    }

    const xdrString = buildXdr([
      invokeWithAuth(hostFn(CUSTOM_CONTRACT, 'root'), [sourceAuth(node)]),
    ])
    const [semantics] = extractSorobanSemantics(xdrString, options)

    expect(semantics.warnings).toContain('deep-authorization-tree')
    expect(semantics.authorizations[0].depth).toBe(5)
    expect(semantics.authorizations[0].invocations).toHaveLength(4)
  })

  it('identifies the asset behind a Stellar asset contract deployment', () => {
    const xdrString = buildXdr([Operation.createStellarAssetContract({ asset: USDC })])

    const [semantics] = extractSorobanSemantics(xdrString, options)
    expect(semantics).toMatchObject({
      kind: 'createContract',
      confidence: 'decoded',
      createdAsset: `USDC:${ISSUER}`,
    })
  })

  it('treats deployment from a wasm hash as opaque', () => {
    const xdrString = buildXdr([
      Operation.createCustomContract({
        address: new Address(SOURCE),
        wasmHash: Buffer.alloc(32, 3),
        salt: Buffer.alloc(32, 4),
      }),
    ])

    const [semantics] = extractSorobanSemantics(xdrString, options)
    expect(semantics.kind).toBe('createContract')
    expect(semantics.confidence).toBe('opaque')
    expect(semantics.createdAsset).toBeUndefined()
  })

  it('treats wasm upload as an opaque payload', () => {
    const xdrString = buildXdr([Operation.uploadContractWasm({ wasm: Buffer.alloc(64, 1) })])

    const [semantics] = extractSorobanSemantics(xdrString, options)
    expect(semantics.kind).toBe('uploadWasm')
    expect(semantics.confidence).toBe('opaque')
    expect(semantics.warnings).toContain('opaque-payload')
  })

  it('sanitises and truncates argument text before it reaches the UI', () => {
    const hostile = `pay${String.fromCharCode(7)}now${'x'.repeat(200)}`
    const xdrString = buildXdr([
      call(CUSTOM_CONTRACT, 'note', nativeToScVal(hostile, { type: 'string' })),
    ])

    const [semantics] = extractSorobanSemantics(xdrString, options)
    const [arg] = semantics.invocation?.args ?? []

    expect(arg.display.startsWith('paynow')).toBe(true)
    expect(arg.display).not.toContain(String.fromCharCode(7))
    expect(arg.display).toHaveLength(67)
    expect(arg.display.endsWith('...')).toBe(true)
  })

  it('summarises structured arguments instead of expanding them', () => {
    const xdrString = buildXdr([
      call(CUSTOM_CONTRACT, 'batch', xdr.ScVal.scvVec([i128(1n), i128(2n)]), xdr.ScVal.scvMap([])),
    ])

    const [semantics] = extractSorobanSemantics(xdrString, options)
    expect(semantics.invocation?.args.map((arg) => arg.display)).toEqual(['vec(2)', 'map(0)'])
  })

  it('reports undecodable arguments rather than guessing at them', () => {
    const xdrString = buildXdr([
      call(CUSTOM_CONTRACT, 'instance', xdr.ScVal.scvLedgerKeyContractInstance()),
    ])

    const [semantics] = extractSorobanSemantics(xdrString, options)
    expect(semantics.warnings).toContain('undecodable-argument')
    expect(semantics.invocation?.args[0].display).toBe('<ledgerKeyContractInstance>')
  })

  it('decodes each Soroban operation in a batch independently', () => {
    const xdrString = buildXdr([
      call(
        USDC_CONTRACT,
        'transfer',
        new Address(SOURCE).toScVal(),
        new Address(RECIPIENT).toScVal(),
        i128(1n),
      ),
      call(CUSTOM_CONTRACT, 'stake', i128(2n)),
    ])

    const results = extractSorobanSemantics(xdrString, options)
    expect(results.map((entry) => entry.confidence)).toEqual(['decoded', 'partial'])
  })

  it('decodes Soroban operations inside a fee-bump envelope', () => {
    const inner = new TransactionBuilder(new Account(SOURCE, '0'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        call(
          USDC_CONTRACT,
          'transfer',
          new Address(SOURCE).toScVal(),
          new Address(RECIPIENT).toScVal(),
          i128(3n),
        ),
      )
      .setTimeout(30)
      .build()
    inner.sign(Keypair.random())

    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      Keypair.random(),
      '1000',
      inner,
      Networks.TESTNET,
    )

    const [semantics] = extractSorobanSemantics(feeBump.toXDR(), options)
    expect(semantics.movements[0]).toMatchObject({ kind: 'transfer', amount: '3' })
  })
})
