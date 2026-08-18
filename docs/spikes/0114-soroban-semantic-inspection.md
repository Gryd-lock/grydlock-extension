# Spike 0114: Soroban semantic inspection strategies

- **Issue:** #114
- **Status:** Complete — recommendation awaiting maintainer decision (see [ADR-0001](../adr/0001-soroban-semantic-inspection.md))
- **Prototype:** [`src/decode/sorobanSemantics.ts`](../../src/decode/sorobanSemantics.ts), [`src/decode/sorobanSemantics.test.ts`](../../src/decode/sorobanSemantics.test.ts)

## Question

What level of Soroban transaction semantics can be safely decoded and presented before signing?

## Answer in one paragraph

Static XDR decoding recovers substantially more than the current pipeline shows: the invoked contract, the function name, every argument as a typed and sanitised value, the full authorisation tree including sub-invocations, and — for the SEP-41 token interface that every Stellar asset contract implements — a well-formed guess at who pays whom. It recovers this in well under a millisecond, offline, with no new trust dependency. What it cannot do is tell the user that the guess is _true_: a contract named `transfer` may do anything, argument amounts have no meaningful units until the token's decimals are known, and any call not on the token interface is semantically opaque. Simulation closes part of that gap but buys it with an RPC dependency, a privacy leak of unsigned transactions, added latency in the signing path, and results that are still only a prediction of execution. The recommendation is a layered design where static decoding ships first and unconditionally, simulation is a later, opt-in enrichment, and the product's honesty about what it does _not_ know is treated as a feature rather than a gap.

## Method

- Catalogued the Soroban operation classes reachable through `signTransaction` against the XDR definitions exposed by `@stellar/stellar-sdk` v16.
- Built a prototype static decoder (`extractSorobanSemantics`) and drove it with 21 synthetic envelopes covering each class, plus hostile inputs.
- Compared static decoding with `simulateTransaction` against the evaluation criteria in the issue.
- Derived the ambiguity, degradation, and presentation rules from what the prototype could and could not justify.

Latency figure quoted below was measured locally with the prototype (Node 22, 500 iterations, single-operation SAC transfer envelope): **0.377 ms per transaction**, including asset-contract-id derivation on every call. That derivation is the dominant cost and is trivially cacheable.

## 1. Representative Soroban transaction classes

| #   | Class                                 | XDR shape                                                      | Real-world example                                         |
| --- | ------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------- |
| C1  | Asset contract transfer               | `invokeContract` on a SAC, `transfer(from, to, amount)`        | Sending USDC to a contract-aware dApp                      |
| C2  | Custom token transfer                 | Same signature, non-SAC contract                               | Any SEP-41 token that is not a wrapped classic asset       |
| C3  | Allowance grant                       | `approve(from, spender, amount, expiration_ledger)`            | AMM or lending protocol asking for spending rights         |
| C4  | Delegated spend                       | `transfer_from` / `burn_from`                                  | Protocol moving funds under a previously granted allowance |
| C5  | Token administration                  | `mint`, `clawback`, `set_admin`, `set_authorized`              | Issuer operations; catastrophic if signed unknowingly      |
| C6  | Arbitrary protocol call               | `invokeContract` with an unrecognised function                 | `swap_exact_in`, `deposit`, `submit_order`                 |
| C7  | Composed call with authorisation tree | Any of the above, plus `auth` entries carrying sub-invocations | dApp call whose authorisation also grants a token transfer |
| C8  | Third-party authorisation             | Auth entry with `sorobanCredentialsAddress` for another signer | Multi-party or sponsored contract flows                    |
| C9  | Asset contract deployment             | `createContract` with `contractIdPreimageFromAsset`            | Wrapping a classic asset for Soroban                       |
| C10 | Custom contract deployment            | `createContract` / `createContractV2` from a wasm hash         | Deploying protocol code                                    |
| C11 | Wasm upload                           | `uploadContractWasm`                                           | Installing contract code                                   |
| C12 | Ledger maintenance                    | `extendFootprintTtl`, `restoreFootprint`                       | Housekeeping; no value transfer, no counterparty           |
| C13 | Fee-bump wrapper                      | Any of the above inside `FeeBumpTransaction`                   | Sponsored submission                                       |

## 2. Supported-semantics matrix

`Static` is what the prototype produces today. `+ Simulation` is what an RPC `simulateTransaction` call would add on top.

| Class | Static                                                                     | Confidence reported       | + Simulation                                                                           |
| ----- | -------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------- |
| C1    | Contract, function, from/to/amount, asset label, 7-decimal precision       | `decoded`                 | Confirms the call succeeds; returns events showing actual balance effects              |
| C2    | Contract, function, from/to/amount; **no** asset label, **no** decimals    | `decoded`                 | Token metadata (`name`, `symbol`, `decimals`) via extra calls; real effects via events |
| C3    | Spender, amount, expiration ledger, unbounded/long-lived warnings          | `decoded`                 | Little added value; allowances are already fully visible statically                    |
| C4    | Spender, from, to, amount                                                  | `decoded`                 | Whether the allowance actually exists and is sufficient                                |
| C5    | Function identified, admin warning raised                                  | `decoded`                 | Whether the signer really is the admin                                                 |
| C6    | Contract, function name, typed arguments only                              | `partial`                 | Balance-change events — the single largest gain from simulation                        |
| C7    | Full flattened authorisation tree, hidden-authorisation warning            | inherits root             | Same tree, plus the effects each sub-invocation causes                                 |
| C8    | Signer address, signature expiration ledger, foreign-authorisation warning | inherits root             | No material gain                                                                       |
| C9    | Asset code and issuer behind the deployment                                | `decoded`                 | No material gain                                                                       |
| C10   | Nothing beyond "a contract is being deployed"                              | `opaque`                  | Nothing without fetching and analysing the wasm                                        |
| C11   | Nothing beyond "code is being installed"                                   | `opaque`                  | Nothing                                                                                |
| C12   | Not inspected; no counterparty exists                                      | n/a (absent from results) | Nothing                                                                                |
| C13   | Inner transaction decoded normally                                         | inherits inner            | Same                                                                                   |

Static decoding therefore gives useful semantics for C1–C5, C7–C9 and C13; C6 is structurally visible but semantically unknown; C10–C11 are irreducibly opaque without off-chain code analysis.

## 3. Static decoding versus RPC simulation

| Criterion              | Static XDR decoding                                                              | RPC simulation                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness            | Exact about _what is being asked for_; silent about what it causes               | Predicts effects, but against a ledger snapshot that may differ at submission                                                                       |
| Security               | No new attack surface; input is already in the extension                         | Adds a network dependency whose responses influence a security warning; a hostile or compromised RPC can shape what the user is told                |
| Latency                | 0.377 ms measured; no network round trip                                         | One or more network round trips in the signing path; unbounded on a slow or throttled endpoint                                                      |
| Privacy                | None lost; nothing leaves the browser                                            | Sends the user's unsigned transaction, addresses and amounts to a third-party endpoint — directly contrary to the no-telemetry stance in PRIVACY.md |
| RPC dependency         | None                                                                             | Hard dependency, plus a new failure mode requiring its own degradation path                                                                         |
| Complexity             | One module, no state, no configuration                                           | Endpoint configuration, network selection, timeouts, retries, caching, error taxonomy, host permissions in the manifest                             |
| User comprehensibility | "This calls `transfer` on USDC for 2.5 USDC" — accurate but a claim about intent | "This moves 2.5 USDC out of your account" — stronger, but risks being read as a guarantee                                                           |

**Verdict.** Simulation is the only route to trustworthy effects for class C6, which is the majority of real dApp traffic. It is not a route Gryd Lock can take unconditionally: it would place a third-party endpoint inside the signing path of a security tool that currently promises to send nothing anywhere. It belongs behind explicit, per-user opt-in, with static decoding remaining the always-available baseline.

## 4. Ambiguity analysis

1. **Signature match is not behaviour.** A contract may expose `transfer(Address, Address, i128)` and do the opposite. Every movement the prototype produces carries `inferred: true`, and the UI contract below requires it to be phrased as an intent, never as a fact.
2. **Amounts have no units without decimals.** Only recognised Stellar asset contracts have statically known precision (7). For every other token, the raw integer is all that is honest to display; a raw `1000000` rendered as `1.0` would be a fabrication.
3. **Token identity is spoofable.** A contract can call itself USDC. The prototype labels an asset only when the contract id equals the id derived from a `code:issuer` pair, which is the one identity check that is cryptographically sound offline.
4. **Authorisation trees can hide the payload.** The operation may invoke a harmless `deposit` while the auth entry authorises a token `transfer` the user never sees. The prototype flags any authorised invocation absent from the top-level call as `hidden-authorization`. This is the single highest-value warning found in the spike.
5. **Allowances are unbounded by construction.** `approve` with a near-`i128::MAX` amount and a distant expiration ledger is a standing right to drain a balance. Statically detectable, and detectable _only_ statically — simulation shows a successful approve as harmless.
6. **Third-party spends look ordinary.** `transfer` whose `from` is not the transaction source, or `transfer_from`, means someone else's balance moves. Flagged as `third-party-transfer`.
7. **Not every `ScAddress` is representable.** Muxed, claimable-balance and liquidity-pool addresses fail address conversion in the SDK. These are reported as undecodable rather than rendered as something plausible.
8. **Argument text is attacker-controlled.** Symbols and strings originate with the dApp. The prototype strips C0/C1 control characters and truncates to 64 characters before anything reaches the popup.
9. **Structures are summarised, not expanded.** Vectors and maps are rendered as `vec(n)` / `map(n)`; deep expansion is an unbounded rendering surface with no security value.
10. **Simulation has its own ambiguity.** Results depend on ledger state at simulation time, can be invalidated before submission, and a failed simulation does not prove a transaction is malicious — only that it would not have succeeded a moment ago.

## 5. Unsupported behaviour policy

The rules below preserve the product's existing safety semantics: Gryd Lock warns, the user decides, and an unassessable transaction degrades to `allow` rather than being silently blocked.

- An operation the decoder cannot explain is reported as `opaque`, never omitted and never guessed at.
- `unknown-function` (class C6) must be presented as _unverified_, with contract and function shown verbatim and no inferred movement.
- Wasm upload and non-asset contract deployment (C10, C11) are presented as "installs code Gryd Lock cannot inspect" and nothing more.
- Undecodable arguments and addresses degrade the individual argument, not the whole operation.
- Authorisation trees deeper than four levels stop being walked and raise `deep-authorization-tree`; a crafted envelope must not drive unbounded recursion or rendering.
- Malformed XDR yields no semantics, which routes into the existing "cannot assess" path.
- The decoder never blocks, never fails a transaction, and throws no exception into the signing path — every decode failure is data, not an error.

## 6. Prototype

`extractSorobanSemantics(xdr, options)` returns one `SorobanSemantics` per `invokeHostFunction` operation, containing:

- `kind` — `invokeContract` / `createContract` / `uploadWasm` / `unsupported`;
- `confidence` — `decoded` / `partial` / `opaque`;
- `invocation` — contract id, function name, typed and sanitised arguments;
- `authorizations` — credential type, signer, signature expiration ledger, flattened invocation tree, depth;
- `movements` — inferred token movements, always marked `inferred`;
- `accounts` / `contracts` — addresses split by type, ready for risk scoring;
- `warnings` — machine-readable codes for the UI layer.

Example, for a SAC `transfer` of 2.5 USDC signed by an account that does not own the funds:

```jsonc
{
  "kind": "invokeContract",
  "confidence": "decoded",
  "invocation": { "contractId": "CA62...IPFO", "functionName": "transfer", "args": [/* 3 */] },
  "movements": [
    {
      "kind": "transfer",
      "asset": "USDC:GBQ6...7MQK",
      "from": "GAJB...MR2Z",
      "to": "GD6C...5SZY7",
      "amount": "25000000",
      "decimals": 7,
      "inferred": true,
    },
  ],
  "accounts": ["GAJB...MR2Z", "GD6C...5SZY7"],
  "contracts": ["CA62...IPFO"],
  "warnings": ["third-party-transfer"],
}
```

The module is pure, has no Chrome or network dependency, and is **not wired into the signing path**. Integration is intentionally deferred to the follow-up work below so that the maintainers decide the UI and scoring contract before user-visible behaviour changes.

Run the prototype's suite with:

```bash
npx vitest run src/decode/sorobanSemantics.test.ts
```

## 7. Recommended architecture

A layered decoder, each layer independently testable and degradable:

| Layer        | Responsibility                                                        | Runs in            | Ships           |
| ------------ | --------------------------------------------------------------------- | ------------------ | --------------- |
| L0 Parse     | Envelope to host functions and auth entries                           | background         | Now (prototype) |
| L1 Structure | Contract, function, typed arguments, auth tree, sanitisation          | background         | Now (prototype) |
| L2 Infer     | Token-interface signature matching, asset identity, warning codes     | background         | Now (prototype) |
| L3 Enrich    | Optional `simulateTransaction`, token metadata, event-derived effects | background, opt-in | Later           |
| L4 Present   | Warning UI: intent, counterparties, warnings, confidence              | popup              | Next            |

Invariants this preserves:

- Decoding stays in the background service worker; the Stellar SDK does not enter the MAIN-world bundle.
- The popup renders what it is given and re-implements no decoding or scoring.
- L3 is strictly additive: with it disabled or failing, L0–L2 output is unchanged.
- Confidence is carried end to end, so the UI can never present a `partial` result with `decoded` language.

## 8. Proposed UI and data contracts

### Extension protocol

`RuntimeSignRequestInfo` in `src/intercept/protocol.ts` already anticipates `kind: 'contractInvocation'` and `function`. The spike proposes completing it rather than inventing a parallel shape:

```ts
export interface RuntimeSorobanInfo {
  contractId: string
  functionName: string
  confidence: 'decoded' | 'partial' | 'opaque'
  movements: Array<{
    kind: string
    asset?: string
    from?: string
    to?: string
    amount?: string
    decimals?: number
  }>
  warnings: SorobanWarningCode[]
}
```

Two consequential notes for the implementer:

- The background currently passes decode results to the popup through `URLSearchParams` on the popup URL. Soroban payloads are far larger than a destination string and will hit URL-length limits. Move to a background-held pending-request record keyed by `requestId`, read by the popup over `chrome.runtime`, before adding Soroban fields.
- Contract addresses are not account addresses. Scoring them through the existing account path would either produce meaningless scores or silently degrade; the oracle contract must distinguish them explicitly.

### Oracle request schema (cross-repository)

```jsonc
{
  "subject": { "type": "account" | "contract", "address": "G... | C..." },
  "context": { "network": "PUBLIC", "functionName": "transfer" }
}
```

This is the change with impact outside this repository and should be agreed with the oracle adapter before the decoder is wired in.

### Warning UI rules

- Lead with intent, phrased as a claim about the request: _"This transaction asks `USDC` to send 2.5 USDC to GD6C…"_.
- Never state an effect as fact for an inferred movement.
- For `partial`, show contract and function and state plainly that Gryd Lock cannot interpret the call.
- For `opaque`, state that the transaction installs or deploys code that cannot be inspected.
- Render warning codes as their own tier-independent list; `hidden-authorization`, `unbounded-approval` and `token-admin-operation` deserve the strongest treatment found in the spike.
- Show addresses truncated but copyable, and argument text exactly as sanitised by L1.

## 9. Follow-up scope

| Follow-up                                           | Scope                   | Depends on                                     |
| --------------------------------------------------- | ----------------------- | ---------------------------------------------- |
| Move pending-request payload off the popup URL      | Small                   | —                                              |
| Wire L0–L2 into `resolveOutcome` and the background | Medium                  | Popup payload change, oracle schema            |
| Soroban warning UI in the popup                     | Medium                  | Protocol contract above                        |
| Oracle schema extension for contract subjects       | Small, cross-repository | Maintainer agreement                           |
| Opt-in L3 simulation behind a setting               | Large                   | Manifest host permissions, privacy review, ADR |
| Token metadata resolution for non-SAC tokens        | Medium                  | L3                                             |

## 10. Open questions for maintainers

1. Should contract addresses be scored at all before the oracle can distinguish them from accounts, or should Soroban warnings ship as semantics-only until then?
2. Is an opt-in RPC dependency acceptable against the current no-telemetry promise, and if so, whose endpoint is the default?
3. Should a `hidden-authorization` or `unbounded-approval` finding raise the warning tier by itself, independently of any oracle score?
