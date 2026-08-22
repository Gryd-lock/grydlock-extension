# ADR-0001: Layered Soroban semantic inspection

- **Status:** Proposed
- **Date:** 2026-08-18
- **Decision owners:** Gryd Lock maintainers
- **Related issue/PR:** #114
- **Supersedes:** None
- **Superseded by:** None

## Context

Gryd Lock decodes destination-bearing classic operations and scores their destinations. Soroban `invokeHostFunction` operations carry no classic destination, so they currently produce no decode result at all and fall through the "cannot assess" path to `allow`. A user signing a contract invocation therefore sees nothing about what they are approving.

Spike [0114](../spikes/0114-soroban-semantic-inspection.md) evaluated how much Soroban meaning can be recovered before signing, and by which strategy: static XDR decoding, RPC simulation, contract manifests, or a combination. The decision is needed now because it determines the shape of the extension's transaction model, the popup's data contract, and a schema change in the oracle repository — all of which later work would otherwise have to guess at.

## Decision drivers

- Gryd Lock is a security tool: a wrong or overconfident explanation is worse than an honest "unknown".
- PRIVACY.md commits to no telemetry and to transaction data not leaving the browser.
- The extension sits in the signing path; added latency is paid by every transaction.
- Warning quality must not depend on the availability of a third-party endpoint.
- The popup must not become a second decoding implementation.

## Considered options

### Option A: Static XDR decoding only

Decode contract, function, arguments and authorisation entries offline. Infer token movements from the SEP-41 signatures every Stellar asset contract implements. Fast, private, no new dependency; cannot report actual effects, and cannot interpret protocol-specific functions.

### Option B: RPC simulation as the primary strategy

Call `simulateTransaction` for every Soroban transaction and present the predicted effects. Strongest explanation for arbitrary contracts; requires sending unsigned transactions to a third-party endpoint, adds unbounded latency to signing, makes warning quality dependent on RPC availability, and lets a hostile endpoint shape what the user is told.

### Option C: Layered — static baseline, optional simulation enrichment

Ship static decoding as an always-available baseline that never depends on the network, and add simulation later as an opt-in enrichment layer that is strictly additive. Costs more structure than either single strategy, and defers full semantics for arbitrary contract calls.

## Decision

Adopt **Option C**.

- Soroban inspection is layered: L0 parse, L1 structure, L2 infer, L3 optional enrichment, L4 present. Layers L0–L2 are offline, deterministic, and must remain so.
- All decoding lives in the background service worker. The Stellar SDK does not enter the MAIN-world bundle, and the popup renders supplied data only.
- Every result carries an explicit confidence of `decoded`, `partial` or `opaque`, and that value is carried end to end so the UI cannot present an uncertain result in certain language.
- Inferred token movements are marked as inferred and must be presented as what the transaction _asks for_, never as what it _does_.
- Anything not statically explainable is reported as `opaque` rather than omitted or guessed, and the transaction continues to degrade to `allow` when it cannot be assessed. The decoder never blocks and never throws into the signing path.
- Argument text is sanitised (control characters stripped, length bounded) and authorisation trees are walked to a bounded depth before rendering.
- Any simulation layer (L3) must be off by default, opt-in per user, and strictly additive: with it disabled or failing, L0–L2 output is unchanged. Introducing it requires its own ADR covering the endpoint, host permissions, and privacy consequences.

## Consequences

### Positive

- Soroban transactions gain meaningful pre-signing explanation with no new trust, network, or privacy dependency.
- Statically detectable, high-severity patterns — hidden authorisation, unbounded allowances, third-party spends, token administration — become visible; simulation would not surface them, since such transactions simulate successfully.
- The confidence contract makes the product's limits explicit rather than implicit.

### Negative

- Arbitrary protocol calls remain semantically unexplained until an opt-in simulation layer exists.
- Token amounts for non-asset-contract tokens must be shown unscaled, which is honest but less readable.
- Signature-based inference will need maintenance as token interfaces evolve.

### Neutral or follow-up work

- The pending-request payload must move off the popup URL before Soroban data is added to it.
- The oracle request schema needs to distinguish contract subjects from account subjects; this change spans repositories.
- The prototype in `src/decode/sorobanSemantics.ts` is not wired into the signing path and remains inert until the UI and scoring contracts are agreed.

## Security and privacy considerations

The decision keeps all Soroban inspection offline, so no wallet request, address, or amount leaves the browser as a result of it, preserving the guarantees in PRIVACY.md. Decoded contract data is attacker-controlled and is treated as such: it is sanitised and bounded before crossing into the popup. Bounded authorisation-tree traversal prevents a crafted envelope from driving unbounded recursion or rendering in the background worker. Existing degradation semantics are unchanged: an unassessable transaction warns nothing extra and is allowed, and the user remains the decision-maker. Deferring simulation keeps a third-party endpoint out of the signing path until its risks are decided deliberately.

## Validation

- Vitest coverage of each catalogued Soroban class, including hostile inputs: unknown functions, undecodable arguments, control-character and oversized strings, deep authorisation trees, foreign authorisation, and fee-bump envelopes.
- Assertions that malformed XDR and non-Soroban transactions yield no semantics, preserving the current "cannot assess" path.
- Existing lint, typecheck, test and build gates, including coverage thresholds.
- Manual verification against a real Freighter Soroban signing flow is required when L4 lands, since interception cannot be reproduced in unit tests.

## Revisit criteria

- A widely adopted contract-manifest or interface-metadata standard makes offline semantics available for arbitrary contracts.
- Simulation becomes available without a third-party network dependency, or the project accepts one explicitly.
- Token interface conventions diverge enough that signature matching produces misleading inferences.
- Measured decode cost stops being negligible in the signing path.
