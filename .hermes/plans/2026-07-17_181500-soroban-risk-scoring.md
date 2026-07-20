# Soroban InvokeHostFunction Risk Scoring Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Extend GrydLock so Soroban `invokeHostFunction` operations are surfaced as scoreable targets instead of silently falling through `allow`.

**Architecture:** Generalize `DecodedDestination` from a plain `{destination, asset?}` shape into a discriminated union with a `payment` arm and a new `contractInvocation` arm. Thread the new shape through `resolveOutcome`, background messaging, and the popup so contract invocations get scored and labeled distinctly from payments.

**Tech Stack:** TypeScript, Vitest, React 18, @stellar/stellar-sdk ^16.0.1, Chrome extension messaging.

---

## Context / Assumptions

- Current `DecodedDestination` in `src/decode/decodeTransaction.ts` only covers the four payment-shaped operations above.
- `invokeHostFunction` ops have `op.type === 'invokeHostFunction'` and a nested `op.hostFunction` object that contains either:
  - `{ type: 'invokeContract', contractAddress, contractFunc, args }` for Wasm contract calls, or
  - `{ type: 'uploadContractWasm', ... }` / `{ type: 'createContract', ... }` for lifecycle ops.
- A transaction with `invokeHostFunction` should yield a scoreable target: the invoked contract address.
- The popup should distinguish **"Contract Invocation <address>"** from **"Account <address>"** to avoid phishing-style confusion—malicious Soroban destination addresses look like ordinary accounts.
- Existing payment tests must stay green.

## Files to change

- `src/decode/decodeTransaction.ts` — generalized destination model + extraction logic for Soroban ops
- `src/decode/decodeTransaction.test.ts` — new tests for every invokeHostFunction shape
- `src/intercept/resolveOutcome.ts` — widen deps/output to carry a kind discriminator
- `src/intercept/resolveOutcome.test.ts` — add contract-invocation test cases
- `src/background/background.ts` — include `kind` and optional `function` label in popup URL params
- `src/popup/App.tsx` — render Soroban operations with distinct label
- `src/popup/TierWarning.tsx` — accept optional `invocationLabel` / `kind` for display
- `README.md` — document Soroban coverage and scoring behavior

## Proposed approach

1. Replace `DecodedDestination` `{destination, asset?}` with a discriminated union:
   - `{ kind: 'payment', destination: string, asset?: string }`
   - `{ kind: 'contractInvocation', destination: string, function?: string }`
2. Update `extractDestination` to:
   - Collect payment destinations unchanged.
   - When no payment destinations are found, look for `invokeHostFunction` ops.
   - If exactly one `invokeHostFunction` op contains an `invokeContract` host function, return the `contractAddress` plus optional `contractFunc`.
   - If multiple distinct contract addresses appear, return `null` (ambiguous).
   - If multiple mixed kinds (payment + contract) appear, return `null` (ambiguous).
3. Thread `kind` through `resolveOutcome` → `requestDecision` → popup URL using a new `invocation` param.
4. In the popup, prefix contract destination display with **"Contract Invocation:"** and include the function name when available.
5. Update docs and tests.

## Step-by-step plan

### Task 1: Replace `DecodedDestination` with a discriminated union

**Objective:** Add a `kind` discriminator so payment operations and contract invocations are modeled separately.

**Files:**
- Modify: `src/decode/decodeTransaction.ts:3-6`

**Current code:**
```ts
export interface DecodedDestination {
  destination: string
  asset?: string
}
```

**New code:**
```ts
export type DecodedDestination =
  | { kind: 'payment'; destination: string; asset?: string }
  | { kind: 'contractInvocation'; destination: string; function?: string }
```

**Step 1: Verify change compiles**

Run: `npx tsc --noEmit`
Expected: TypeError in files that use `DecodedDestination` — that's expected, will be fixed by subsequent tasks.

**Step 2: Commit**

```bash
git add src/decode/decodeTransaction.ts
git commit -m "chore: introduce discriminated DecodedDestination union"
```

---

### Task 2: Add `invokeHostFunction` extraction logic

**Objective:** Extend `extractDestination` to look for Soroban contract invocations when no payment destination is found.

**Files:**
- Modify: `src/decode/decodeTransaction.ts:15-55`

**New logic:**

```ts
const DESTINATION_OPERATION_TYPES = new Set([
  'payment',
  'pathPaymentStrictSend',
  'pathPaymentStrictReceive',
  'createAccount',
])

// Soroban hostFunction shapes that can carry a contractAddress we want to score
const INVOKE_CONTRACT_TYPES = new Set(['invokeContract'])

function assetLabel(op: Record<string, unknown>): string | undefined {
  const asset = (op.asset ?? op.destAsset) as Asset | undefined
  if (!asset || asset.isNative()) return undefined
  return `${asset.getCode()}:${asset.getIssuer()}`
}

function hostFunctionLabel(op: Record<string, unknown>): string | undefined {
  const hf = op.hostFunction as Record<string, unknown> | undefined
  if (!hf || typeof hf !== 'object') return undefined
  if (hf.type === 'invokeContract' && typeof hf.contractFunc === 'string') {
    return hf.contractFunc
  }
  return undefined
}

export function extractDestination(
  xdr: string,
  networkPassphrase: string = Networks.TESTNET,
): DecodedDestination | null {
  let parsed
  try {
    parsed = TransactionBuilder.fromXDR(xdr, networkPassphrase)
  } catch {
    return null
  }

  const tx = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed
  const destinations = new Set<string>()
  const kinds = new Set<'payment' | 'contractInvocation'>()
  let asset: string | undefined
  let functionName: string | undefined

  for (const op of tx.operations) {
    if (DESTINATION_OPERATION_TYPES.has(op.type) && 'destination' in op && op.destination) {
      destinations.add(op.destination as string)
      kinds.add('payment')
      asset = assetLabel(op as unknown as Record<string, unknown>)
    } else if (op.type === 'invokeHostFunction') {
      const raw = op as unknown as Record<string, unknown>
      const hf = raw.hostFunction as Record<string, unknown> | undefined
      if (hf && INVOKE_CONTRACT_TYPES.has(hf.type as string) && 'contractAddress' in hf) {
        destinations.add(hf.contractAddress as string)
        kinds.add('contractInvocation')
        functionName = hostFunctionLabel(raw)
      }
    }
  }

  if (destinations.size !== 1 || kinds.size !== 1) {
    return null
  }

  if (kinds.has('payment')) {
    return { kind: 'payment', destination: [...destinations][0], asset }
  }

  return { kind: 'contractInvocation', destination: [...destinations][0], function: functionName }
}
```

**Step 1: Write failing tests for the new behavior**

Add to `src/decode/decodeTransaction.test.ts`:

```ts
  it('extracts the contract address from a single invokeHostFunction invokeContract', () => {
    const xdr = buildXdr([
      Operation.invokeHostFunction({
        source: SOURCE,
        hostFunction: {
          type: 'invokeContract',
          contractAddress: DEST_A,
          contractFunc: 'transfer',
          args: [],
        },
      }),
    ])
    expect(extractDestination(xdr, Networks.TESTNET)).toEqual({
      kind: 'contractInvocation',
      destination: DEST_A,
      function: 'transfer',
    })
  })

  it('returns null for invokeHostFunction without invokeContract', () => {
    const xdr = buildXdr([
      Operation.invokeHostFunction({
        source: SOURCE,
        hostFunction: { type: 'uploadContractWasm', wasm: Buffer.from('abc') },
      }),
    ])
    expect(extractDestination(xdr, Networks.TESTNET)).toBeNull()
  })

  it('returns null for invokeHostFunction missing contractAddress', () => {
    const xdr = buildXdr([
      Operation.invokeHostFunction({
        source: SOURCE,
        hostFunction: {
          type: 'invokeContract',
          contractFunc: 'transfer',
          args: [],
        } as any,
      }),
    ])
    expect(extractDestination(xdr, Networks.TESTNET)).toBeNull()
  })

  it('returns null when multiple contract invocations appear', () => {
    const xdr = buildXdr([
      Operation.invokeHostFunction({
        source: SOURCE,
        hostFunction: {
          type: 'invokeContract',
          contractAddress: DEST_A,
          contractFunc: 'transfer',
          args: [],
        },
      }),
      Operation.invokeHostFunction({
        source: SOURCE,
        hostFunction: {
          type: 'invokeContract',
          contractAddress: DEST_B,
          contractFunc: 'approve',
          args: [],
        },
      }),
    ])
    expect(extractDestination(xdr, Networks.TESTNET)).toBeNull()
  })
```

**Note:** Because existing payment tests call `extractDestination` and the returned shape now requires `kind: 'payment'`, those existing tests will fail until updated. Update the existing six payment-shape expectations in the test file to assert:

```ts
expect(extractDestination(xdr, Networks.TESTNET)).toEqual({
  kind: 'payment',
  destination: DEST_A,
  asset: undefined,
})
```
(and the non-native asset version with `asset: 'USD:${ISSUER}'`, and the path-payment version similarly).

**Step 2: Run tests to verify failures/passes**

Run: `npm test`
Expected: Old payment tests fail (missing `kind`), new Soroban tests fail (no extraction logic yet). Total failures should match the number of payment assertions plus the four new Soroban tests.

**Step 3: Apply the new `extractDestination` body above.**

**Step 4: Run tests to verify pass**

Run: `npm test`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add src/decode/decodeTransaction.ts src/decode/decodeTransaction.test.ts
git commit -m "feat: extract contract destinations from invokeHostFunction operations"
```

---

### Task 3: Update `resolveOutcome` to predicate on `kind`

**Objective:** The scoring and decision info passed to the popup must convey whether the target is an account or a contract.

**Files:**
- Modify: `src/intercept/resolveOutcome.ts:3-7,14-21`
- Modify: `src/intercept/resolveOutcome.test.ts:4,24,26,30,37,39`

**Change `ResolveOutcomeDeps` to accept `DecodedDestination` directly:**

```ts
import type { DecodedDestination } from '../decode/decodeTransaction'

export interface ResolveOutcomeDeps {
  extractDestination: (xdr: string) => DecodedDestination | null
  getScore: (destination: string) => Promise<number>
  requestDecision: (info: {
    destination: string
    kind: DecodedDestination['kind']
    asset?: string
    function?: string
    score: number
  }) => Promise<Decision>
}
```

**Change `resolveOutcome`:**

```ts
export async function resolveOutcome(xdr: string, deps: ResolveOutcomeDeps): Promise<Outcome> {
  const decoded = deps.extractDestination(xdr)
  if (!decoded) return 'allow'

  const score = await deps.getScore(decoded.destination)
  return deps.requestDecision({
    destination: decoded.destination,
    kind: decoded.kind,
    asset: decoded.kind === 'payment' ? decoded.asset : undefined,
    function: decoded.kind === 'contractInvocation' ? decoded.function : undefined,
    score,
  })
}
```

**Update `resolveOutcome.test.ts`:** change `extractDestination: () => null` and existing `extractDestination: () => ({ destination: 'GDEST', asset: 'USD:GISSUER' })` to include `kind: 'payment'`; add a new test case:

```ts
  it('scores a contract invocation and returns the requested decision', async () => {
    const getScore = vi.fn().mockResolvedValue(87)
    const requestDecision = vi.fn().mockResolvedValue('cancel')

    const outcome = await resolveOutcome('some-xdr', {
      extractDestination: () => ({ kind: 'contractInvocation', destination: 'GABCD...', function: 'transfer' }),
      getScore,
      requestDecision,
    })

    expect(getScore).toHaveBeenCalledWith('GABCD...')
    expect(requestDecision).toHaveBeenCalledWith({
      destination: 'GABCD...',
      kind: 'contractInvocation',
      function: 'transfer',
      score: 87,
    })
    expect(outcome).toBe('cancel')
  })
```

**Step 1: Run test to verify failure**

Run: `npm test`
Expected: resolveOutcome tests fail with missing `kind` field.

**Step 2: Apply code changes above.**

**Step 3: Run test to verify pass**

Run: `npm test`
Expected: All resolveOutcome tests pass.

**Step 4: Commit**

```bash
git add src/intercept/resolveOutcome.ts src/intercept/resolveOutcome.test.ts
git commit -m "refactor: thread destination kind through resolveOutcome"
```

---

### Task 4: Pass `kind`/`function` to the popup via URL params

**Objective:** The popup window must receive whether it is displaying an account payment or a contract invocation.

**Files:**
- Modify: `src/background/background.ts:22-37`

**Current code:**

```ts
    const params = new URLSearchParams({
      mode: 'intercept',
      requestId,
      destination: info.destination,
      score: String(info.score),
    })
    if (info.asset) params.set('asset', info.asset)
```

**New code:**

```ts
    const params = new URLSearchParams({
      mode: 'intercept',
      requestId,
      destination: info.destination,
      score: String(info.score),
      kind: info.kind,
    })
    if (info.asset) params.set('asset', info.asset)
    if (info.function) params.set('function', info.function)
```

**Step 1: Run typecheck to verify failure.**

Run: `npm run typecheck`
Expected: `background.ts` expects `kind` on `info`, `requestDecision` from `resolveOutcome` now provides it — at the call site no compile errors should appear; this change is the call site, so after Task 3 it should already compile. If errors appear, fix them.

**Step 2: Run tests.**

Run: `npm test`
Expected: Pass.

**Step 3: Commit.**

```bash
git add src/background/background.ts
git commit -m "feat: forward kind and contractFunction in intercept popup URL"
```

---

### Task 5: Render a distinct popup label for contract invocations

**Objective:** The popup must help the user understand that the destination is a Soroban contract, not a Stellar account.

**Files:**
- Modify: `src/popup/App.tsx:21-42`
- Modify: `src/popup/TierWarning.tsx` (add prop + render label branch)
- Modify: `src/app.tsx` / `src/popup/index.html` if URL params need declaration

**`App.tsx` — `InterceptView`:**

```tsx
function InterceptView({ params }: { params: URLSearchParams }) {
  const requestId = params.get('requestId') ?? ''
  const destination = params.get('destination') ?? ''
  const asset = params.get('asset') ?? undefined
  const functionName = params.get('function') ?? undefined
  const kind = params.get('kind') as 'payment' | 'contractInvocation' | null
  const score = Number(params.get('score') ?? '0')
  const tier = tierForScore(score)

  function respond(decision: 'proceed' | 'cancel') {
    const message: RuntimeDecisionMadeMessage = { type: 'DECISION_MADE', requestId, decision }
    chrome.runtime.sendMessage(message)
    window.close()
  }

  const invocationLabel =
    kind === 'contractInvocation' && functionName
      ? `Contract Invocation: ${functionName}()`
      : kind === 'contractInvocation'
        ? 'Contract Invocation'
        : asset
          ? `${destination} (${asset})`
          : destination

  return (
    <TierWarning
      tier={tier}
      score={score}
      destination={kind === 'contractInvocation' ? `${invocationLabel} @ ${destination}` : invocationLabel}
      onCancel={() => respond('cancel')}
      onProceed={() => respond('proceed')}
    />
  )
}
```

**`TierWarning.tsx`** — no changes required because `destination` prop already accepts a string. The labeling logic lives in `App.tsx`.

**Step 1: Run typecheck.**

Run: `npm run typecheck`
Expected: No errors.

**Step 2: Run tests.**

Run: `npm test`
Expected: Existing popup tests still green. If any snapshots/assertions hard-code destination display, update them in `src/popup/App.test.tsx`.

**Step 3: Commit.**

```bash
git add src/popup/App.tsx src/popup/TierWarning.tsx
git commit -m "feat: render distinct label for Soroban contract invocations in popup"
```

---

### Task 6: Add popup integration test for contract-invocation flow

**Objective:** Prove the end-to-end popup path renders the contract invocation label and disables proceed if score is critical (or whatever the tier logic dictates).

**Files:**
- Modify: `src/popup/App.test.tsx`

**What to test:**
1. Intercept mode with `?mode=intercept&destination=GABCD...&kind=contractInvocation&function=transfer&score=42`
   renders a destination string containing both `"Contract Invocation"` and `"transfer()"`.
2. Intercept mode with `kind=payment` still displays the raw `destination (asset)` label.

**Example test skeleton:**

```tsx
test('renders contract invocation label with function name', async () => {
  render(<App />, { wrapper })
  // intercept mode view renders directly; no fetch in App.tsx intercept path
  const label = screen.getByText(/Contract Invocation/i)
  expect(label).toBeDefined()
})
```

**Step 1: Write test.**

**Step 2: Run test.**

Run: `npm test`
Expected: Pass. If `screen.getByText` needs a different query, adjust after confirming by running it.

**Step 3: Commit.**

```bash
git add src/popup/App.test.tsx
git commit -m "test: popup contract-invocation label rendering"
```

---

### Task 7: Update README

**Objective:** Document the new Soroban coverage.

**Files:**
- Modify: `README.md`

**Changes:**
- In the "How the Pieces Connect" section, update:
  > `src/decode/decodeTransaction.ts → extractDestination(xdr)`  
  — add: "returns `kind: 'contractInvocation'` for Soroban `invokeHostFunction` ops targeting a single contract."

- In the "Decode the transaction XDR → extract destination address / asset" line in the flow diagram, expand to:
  > `Decode the transaction XDR → extract destination address / asset / contract invocation`

- Add a new bullet under the tech/behaviour section noting: "Soroban smart-contract calls (`invokeHostFunction`) are scored and labeled as **Contract Invocation** in the popup."

**Step 1: Run all quality gates.**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: All pass.

**Step 2: Commit.**

```bash
git add README.md
git commit -m "docs: document Soroban invokeHostFunction coverage"
```

---

## Verification

After all tasks complete, run the full gate locally:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Expected: zero lint warnings, zero type errors, all Vitest tests pass, build bundles successfully.

## Task ordering

| # | Deliverable |
|---|---|
| 1 | `DecodedDestination` discriminated union |
| 2 | Full `invokeHostFunction` extraction + tests |
| 3 | `resolveOutcome` kind threading |
| 4 | Background passes kind/function in URL |
| 5 | Popup distinct label rendering |
| 6 | Popup integration test for Soroban label |
| 7 | README update + final gate pass |

## Risks / Tradeoffs / Open questions

- **Discriminated union breakage:** Any consumer of `DecodedDestination` beyond those identified above (e.g. `src/adapter/oracleAdapter.test.ts`, future intercept code) must be updated. The union is currently used in 5 files (per `search_files`); all are covered in the tasks above.
- **Multiple `invokeHostFunction` in one tx:** Treated as `null`/ambiguous, same as multi-destination payment batches. This is conservative and safe.
- **uploadContractWasm / createContract:** These lifecycle ops lack a meaningful `contractAddress` from the user's perspective; they return `null` (no destination to score). Only `invokeContract` is scored. If the maintainers want lifecycle ops excluded silently rather than null, the `kind` could introduce a third `creatorContract` arm — but that is out of this issue's scope.
- **Popup label UX:** The chosen display `"Contract Invocation: transfer() @ GABCD..."` may be long on narrow popup widths (320px). `TierWarning.tsx` currently wraps the destination in a `<p className="destination">`; CSS wrapping handles overflow. No CSS edits are needed for basic readability.
- **Duplicate destination (same account appears in one payment + one invokeHostFunction):** Treated as ambiguous (`kinds.size === 2` → `null`). A maintainer could later relax this to score the account, but we choose the conservative null for safety.

---