import {
  Address,
  Asset,
  FeeBumpTransaction,
  Networks,
  TransactionBuilder,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'
import type { Transaction } from '@stellar/stellar-sdk'
import { resolveNetworkPassphrase } from './decodeTransaction'

/**
 * Static, offline inspection of Soroban host-function operations.
 *
 * This is the spike prototype for issue #114. It answers one question only:
 * how much transaction meaning can be recovered from the XDR alone, with no
 * RPC call, no simulation, and no network round trip.
 *
 * Deliberate limits (see docs/spikes/0114-soroban-semantic-inspection.md):
 * - it never claims a movement actually happened, only that the call *shape*
 *   matches a known token signature;
 * - anything it cannot explain is reported as `opaque` rather than guessed;
 * - it does not decide outcomes and is not wired into the signing path.
 */

/** Host-function class of a single Soroban operation. */
export type SorobanOperationKind =
  'invokeContract' | 'createContract' | 'uploadWasm' | 'unsupported'

/**
 * How much of the operation's meaning was recovered.
 *
 * - `decoded` — structure and semantics are known (recognised token signature).
 * - `partial` — structure decoded, semantics unknown (unrecognised function).
 * - `opaque` — not statically inspectable, or an argument resisted decoding.
 */
export type SorobanConfidence = 'decoded' | 'partial' | 'opaque'

/** Machine-readable warning codes surfaced to the UI layer. */
export type SorobanWarningCode =
  | 'unknown-function'
  | 'undecodable-argument'
  | 'unbounded-approval'
  | 'long-lived-approval'
  | 'third-party-transfer'
  | 'token-admin-operation'
  | 'hidden-authorization'
  | 'foreign-authorization'
  | 'deep-authorization-tree'
  | 'opaque-payload'

export interface SorobanArgument {
  /** SCVal discriminant without the `scv` prefix, e.g. `address`, `i128`, `vec`. */
  type: string
  /** Truncated, control-character-free rendering safe to show in the popup. */
  display: string
  /** Present when the argument is an address. */
  address?: string
  /** Present for integer arguments; decimal string, never a JS number. */
  amount?: string
}

export interface SorobanInvocation {
  contractId: string
  functionName: string
  args: SorobanArgument[]
}

export interface SorobanAuthorization {
  /** `sourceAccount` when the transaction source authorises, otherwise an address signature. */
  credentials: 'sourceAccount' | 'address'
  /** Signer address for `address` credentials. */
  signer?: string
  /** Ledger after which the signature is no longer valid, for `address` credentials. */
  signatureExpirationLedger?: number
  /** Flattened root + sub-invocation tree, in pre-order. */
  invocations: SorobanInvocation[]
  /** Depth of the authorised invocation tree (root counts as 1). */
  depth: number
}

export type SorobanMovementKind = 'transfer' | 'mint' | 'burn' | 'clawback' | 'approve'

export interface SorobanAssetMovement {
  kind: SorobanMovementKind
  /** Token contract the movement is denominated in. */
  contractId: string
  /** Human label when the token contract is a recognised Stellar asset contract. */
  asset?: string
  from?: string
  to?: string
  /** Third party spending an existing allowance, for `transfer_from` / `burn_from`. */
  spender?: string
  /** Raw contract amount as a decimal string; unscaled unless `decimals` is set. */
  amount?: string
  /** Only set when the token's precision is known statically (recognised asset contract). */
  decimals?: number
  /**
   * Always true: static decoding matches a call signature, it does not observe
   * ledger effects. A contract may implement `transfer` with any behaviour.
   */
  inferred: true
}

export interface SorobanSemantics {
  kind: SorobanOperationKind
  confidence: SorobanConfidence
  invocation?: SorobanInvocation
  /** Asset contract deployed by a `createContract` host function, when identifiable. */
  createdAsset?: string
  authorizations: SorobanAuthorization[]
  /** Account (`G...`) addresses referenced by the call or its authorisations. */
  accounts: string[]
  /** Contract (`C...`) addresses referenced by the call or its authorisations. */
  contracts: string[]
  movements: SorobanAssetMovement[]
  warnings: SorobanWarningCode[]
}

export interface SorobanDecodeOptions {
  networkPassphrase?: string
  /**
   * Classic assets whose Stellar asset contract should be labelled and treated
   * as having 7-decimal precision. The native asset is always included.
   */
  knownAssets?: Array<{ code: string; issuer: string }>
}

/** Maximum characters kept for any single rendered argument. */
const MAX_DISPLAY_LENGTH = 64

/** Authorisation trees deeper than this are flagged rather than fully rendered. */
const MAX_AUTH_DEPTH = 4

/** An `i128` approval at or above this is effectively an unlimited allowance. */
const UNBOUNDED_APPROVAL_THRESHOLD = 2n ** 100n

/** Roughly 30 days of ledgers at five seconds per ledger. */
const LONG_APPROVAL_LEDGERS = 518_400n

/** Precision of every Stellar asset contract. */
const SAC_DECIMALS = 7

/** C0/C1 control characters must never reach the popup. */
function stripControlCharacters(text: string): string {
  return Array.from(text)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0
      return code > 0x1f && (code < 0x7f || code > 0x9f)
    })
    .join('')
}

interface TokenSignature {
  kind?: SorobanMovementKind
  /** Argument index of each role, when the signature carries it. */
  roles: { from?: number; to?: number; spender?: number; amount?: number; expiration?: number }
  admin?: boolean
}

/**
 * Signatures of the SEP-41 token interface, which every Stellar asset contract
 * implements and most custom tokens copy. Matching a signature proves only that
 * the call *looks like* a token operation.
 */
const TOKEN_SIGNATURES: Record<string, TokenSignature> = {
  transfer: { kind: 'transfer', roles: { from: 0, to: 1, amount: 2 } },
  transfer_from: { kind: 'transfer', roles: { spender: 0, from: 1, to: 2, amount: 3 } },
  mint: { kind: 'mint', roles: { to: 0, amount: 1 } },
  burn: { kind: 'burn', roles: { from: 0, amount: 1 } },
  burn_from: { kind: 'burn', roles: { spender: 0, from: 1, amount: 2 } },
  clawback: { kind: 'clawback', roles: { from: 0, amount: 1 } },
  approve: { kind: 'approve', roles: { from: 0, spender: 1, amount: 2, expiration: 3 } },
  set_admin: { roles: {}, admin: true },
  set_authorized: { roles: {}, admin: true },
}

function scValTypeName(value: xdr.ScVal): string {
  const name = value.switch().name.replace(/^scv/, '')
  return name.charAt(0).toLowerCase() + name.slice(1)
}

function truncate(text: string): string {
  // Control characters are stripped before truncation so a crafted argument
  // cannot inject line breaks or terminal escapes into the warning UI.
  const clean = stripControlCharacters(text)
  return clean.length > MAX_DISPLAY_LENGTH ? `${clean.slice(0, MAX_DISPLAY_LENGTH)}...` : clean
}

function addressFromScAddress(address: xdr.ScAddress): string | undefined {
  try {
    return Address.fromScAddress(address).toString()
  } catch {
    // Muxed, claimable-balance and liquidity-pool addresses are not
    // representable here; they are reported as undecodable instead of guessed.
    return undefined
  }
}

function integerString(value: xdr.ScVal): string | undefined {
  try {
    const native = scValToNative(value)
    if (typeof native === 'bigint' || typeof native === 'number') return native.toString()
    return undefined
  } catch {
    return undefined
  }
}

function describeArgument(value: xdr.ScVal): SorobanArgument {
  const type = scValTypeName(value)

  switch (value.switch()) {
    case xdr.ScValType.scvAddress(): {
      const address = addressFromScAddress(value.address())
      return address
        ? { type, display: address, address }
        : { type, display: '<unsupported address>' }
    }
    case xdr.ScValType.scvBool():
      return { type, display: String(value.b()) }
    case xdr.ScValType.scvVoid():
      return { type, display: 'void' }
    case xdr.ScValType.scvSymbol():
    case xdr.ScValType.scvString(): {
      const raw = scValToNative(value)
      return {
        type,
        display: truncate(typeof raw === 'string' ? raw : Buffer.from(raw).toString('hex')),
      }
    }
    case xdr.ScValType.scvBytes():
      return { type, display: truncate(value.bytes().toString('hex')) }
    case xdr.ScValType.scvVec():
      return { type, display: `vec(${value.vec()?.length ?? 0})` }
    case xdr.ScValType.scvMap():
      return { type, display: `map(${value.map()?.length ?? 0})` }
    default: {
      const amount = integerString(value)
      if (amount !== undefined) return { type, display: amount, amount }
      return { type, display: `<${type}>` }
    }
  }
}

function invocationFromArgs(args: xdr.InvokeContractArgs): SorobanInvocation | undefined {
  const contractId = addressFromScAddress(args.contractAddress())
  if (!contractId) return undefined

  return {
    contractId,
    functionName: truncate(args.functionName().toString()),
    args: args.args().map(describeArgument),
  }
}

function flattenAuthorizedInvocation(
  node: xdr.SorobanAuthorizedInvocation,
  depth: number,
  acc: SorobanInvocation[],
): number {
  const fn = node.function()
  if (fn.switch() === xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()) {
    const invocation = invocationFromArgs(fn.contractFn())
    if (invocation) acc.push(invocation)
  }

  let maxDepth = depth
  if (depth < MAX_AUTH_DEPTH) {
    for (const child of node.subInvocations()) {
      maxDepth = Math.max(maxDepth, flattenAuthorizedInvocation(child, depth + 1, acc))
    }
  } else if (node.subInvocations().length > 0) {
    // Stop walking rather than let a crafted tree drive unbounded recursion;
    // the caller still learns the tree was deeper than the display limit.
    maxDepth = depth + 1
  }

  return maxDepth
}

function describeAuthorization(entry: xdr.SorobanAuthorizationEntry): SorobanAuthorization {
  const invocations: SorobanInvocation[] = []
  const depth = flattenAuthorizedInvocation(entry.rootInvocation(), 1, invocations)
  const credentials = entry.credentials()

  if (credentials.switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddress()) {
    const address = credentials.address()
    return {
      credentials: 'address',
      signer: addressFromScAddress(address.address()),
      signatureExpirationLedger: address.signatureExpirationLedger(),
      invocations,
      depth,
    }
  }

  return { credentials: 'sourceAccount', invocations, depth }
}

function assetLabelsByContractId(options: SorobanDecodeOptions): Map<string, string> {
  const passphrase = resolveNetworkPassphrase(options.networkPassphrase ?? Networks.PUBLIC)
  const labels = new Map<string, string>()

  const register = (asset: Asset, label: string) => {
    try {
      labels.set(asset.contractId(passphrase), label)
    } catch {
      // An unusable asset definition simply stays unlabelled.
    }
  }

  register(Asset.native(), 'XLM')
  for (const { code, issuer } of options.knownAssets ?? []) {
    try {
      register(new Asset(code, issuer), `${code}:${issuer}`)
    } catch {
      // Ignore malformed caller-supplied assets rather than failing the decode.
    }
  }

  return labels
}

function movementFor(
  invocation: SorobanInvocation,
  signature: TokenSignature,
  assetLabel: string | undefined,
): SorobanAssetMovement | undefined {
  if (!signature.kind) return undefined

  const at = (index: number | undefined) =>
    index === undefined ? undefined : invocation.args[index]

  return {
    kind: signature.kind,
    contractId: invocation.contractId,
    asset: assetLabel,
    from: at(signature.roles.from)?.address,
    to: at(signature.roles.to)?.address,
    spender: at(signature.roles.spender)?.address,
    amount: at(signature.roles.amount)?.amount,
    decimals: assetLabel ? SAC_DECIMALS : undefined,
    inferred: true,
  }
}

function atLeast(value: string | undefined, threshold: bigint): boolean {
  if (value === undefined) return false
  try {
    return BigInt(value) >= threshold
  } catch {
    // A non-numeric amount is already reported through `undecodable-argument`.
    return false
  }
}

function approvalWarnings(
  invocation: SorobanInvocation,
  signature: TokenSignature,
  warnings: Set<SorobanWarningCode>,
) {
  const amount = invocation.args[signature.roles.amount ?? -1]?.amount
  if (atLeast(amount, UNBOUNDED_APPROVAL_THRESHOLD)) warnings.add('unbounded-approval')

  const expiration = invocation.args[signature.roles.expiration ?? -1]?.amount
  if (atLeast(expiration, LONG_APPROVAL_LEDGERS)) warnings.add('long-lived-approval')
}

function collectAddresses(semantics: SorobanSemantics) {
  const accounts = new Set<string>()
  const contracts = new Set<string>()

  const add = (address: string | undefined) => {
    if (!address) return
    if (address.startsWith('C')) contracts.add(address)
    else if (address.startsWith('G')) accounts.add(address)
  }

  const addInvocation = (invocation: SorobanInvocation) => {
    add(invocation.contractId)
    for (const arg of invocation.args) add(arg.address)
  }

  if (semantics.invocation) addInvocation(semantics.invocation)
  for (const auth of semantics.authorizations) {
    add(auth.signer)
    for (const invocation of auth.invocations) addInvocation(invocation)
  }

  semantics.accounts = Array.from(accounts)
  semantics.contracts = Array.from(contracts)
}

function invocationKey(invocation: SorobanInvocation): string {
  return `${invocation.contractId}:${invocation.functionName}`
}

function authorizationWarnings(
  semantics: SorobanSemantics,
  sourceAccount: string | undefined,
  warnings: Set<SorobanWarningCode>,
) {
  const declared = new Set(semantics.invocation ? [invocationKey(semantics.invocation)] : [])

  for (const auth of semantics.authorizations) {
    if (auth.depth > MAX_AUTH_DEPTH) warnings.add('deep-authorization-tree')
    if (auth.credentials === 'address' && auth.signer && auth.signer !== sourceAccount) {
      warnings.add('foreign-authorization')
    }
    for (const invocation of auth.invocations) {
      // An authorised call the top-level invocation does not name is a call the
      // user is signing for without seeing it in the operation itself.
      if (!declared.has(invocationKey(invocation))) warnings.add('hidden-authorization')
    }
  }
}

function decodeInvokeContract(
  args: xdr.InvokeContractArgs,
  semantics: SorobanSemantics,
  assetLabels: Map<string, string>,
  sourceAccount: string | undefined,
  warnings: Set<SorobanWarningCode>,
) {
  const invocation = invocationFromArgs(args)
  if (!invocation) {
    semantics.confidence = 'opaque'
    warnings.add('opaque-payload')
    return
  }

  semantics.invocation = invocation
  if (invocation.args.some((arg) => arg.display.startsWith('<'))) {
    warnings.add('undecodable-argument')
  }

  const signature = TOKEN_SIGNATURES[invocation.functionName]
  if (!signature) {
    semantics.confidence = 'partial'
    warnings.add('unknown-function')
    return
  }

  semantics.confidence = 'decoded'
  if (signature.admin) warnings.add('token-admin-operation')
  if (invocation.functionName === 'approve') approvalWarnings(invocation, signature, warnings)

  const movement = movementFor(invocation, signature, assetLabels.get(invocation.contractId))
  if (!movement) return

  semantics.movements.push(movement)
  if (
    movement.kind === 'transfer' &&
    movement.from &&
    sourceAccount &&
    movement.from !== sourceAccount
  ) {
    warnings.add('third-party-transfer')
  }
}

function decodeCreateContract(preimage: xdr.ContractIdPreimage, semantics: SorobanSemantics) {
  if (preimage.switch() === xdr.ContractIdPreimageType.contractIdPreimageFromAsset()) {
    try {
      const asset = Asset.fromOperation(preimage.fromAsset())
      semantics.createdAsset = asset.isNative() ? 'XLM' : `${asset.getCode()}:${asset.getIssuer()}`
      semantics.confidence = 'decoded'
      return
    } catch {
      // Fall through to the opaque case below.
    }
  }

  // Deploying from a wasm hash tells the user nothing about the code being
  // installed without fetching and analysing that wasm.
  semantics.confidence = 'opaque'
}

/** Decodes one already-parsed `invokeHostFunction` operation. */
export function extractOperationSemantics(
  func: xdr.HostFunction,
  auth: readonly xdr.SorobanAuthorizationEntry[] = [],
  sourceAccount?: string,
  options: SorobanDecodeOptions = {},
): SorobanSemantics {
  const warnings = new Set<SorobanWarningCode>()
  const semantics: SorobanSemantics = {
    kind: 'unsupported',
    confidence: 'opaque',
    authorizations: auth.map(describeAuthorization),
    accounts: [],
    contracts: [],
    movements: [],
    warnings: [],
  }

  switch (func.switch()) {
    case xdr.HostFunctionType.hostFunctionTypeInvokeContract():
      semantics.kind = 'invokeContract'
      decodeInvokeContract(
        func.invokeContract(),
        semantics,
        assetLabelsByContractId(options),
        sourceAccount,
        warnings,
      )
      break
    case xdr.HostFunctionType.hostFunctionTypeCreateContract():
      semantics.kind = 'createContract'
      decodeCreateContract(func.createContract().contractIdPreimage(), semantics)
      break
    case xdr.HostFunctionType.hostFunctionTypeCreateContractV2():
      semantics.kind = 'createContract'
      decodeCreateContract(func.createContractV2().contractIdPreimage(), semantics)
      break
    case xdr.HostFunctionType.hostFunctionTypeUploadContractWasm():
      semantics.kind = 'uploadWasm'
      warnings.add('opaque-payload')
      break
    default:
      warnings.add('opaque-payload')
      break
  }

  collectAddresses(semantics)
  authorizationWarnings(semantics, sourceAccount, warnings)
  semantics.warnings = Array.from(warnings)
  return semantics
}

/**
 * Decodes every Soroban host-function operation in a transaction envelope.
 *
 * Returns an empty array for classic-only transactions and for XDR that cannot
 * be parsed, so callers keep the existing "cannot assess" degradation path.
 */
export function extractSorobanSemantics(
  xdrString: string,
  options: SorobanDecodeOptions = {},
): SorobanSemantics[] {
  let tx: Transaction
  try {
    const parsed = TransactionBuilder.fromXDR(
      xdrString,
      resolveNetworkPassphrase(options.networkPassphrase ?? Networks.PUBLIC),
    )
    tx = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed
  } catch {
    return []
  }

  const results: SorobanSemantics[] = []
  for (const op of tx.operations) {
    if (op.type !== 'invokeHostFunction') continue
    results.push(extractOperationSemantics(op.func, op.auth ?? [], op.source ?? tx.source, options))
  }

  return results
}
