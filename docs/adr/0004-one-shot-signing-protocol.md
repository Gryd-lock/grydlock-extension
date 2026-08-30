# ADR-0004: One-shot signing protocol with a durable state machine

- **Status:** Accepted
- **Date:** 2026-08-30
- **Decision owners:** Gryd Lock maintainers
- **Related issue/PR:** epic — replace the best-effort page-message/runtime-callback signing flow
- **Supersedes:** None (extends ADR-0003, which explicitly deferred this work: "Browser interception retains its existing request/decision contract")
- **Superseded by:** None

## Context

Before this change, the request/decision contract had five structural gaps, all confirmed against the code, not just the original audit:

1. `mainWorldEntry.ts`/`albedoMainWorldEntry.ts` generated `localId = crypto.randomUUID()` and `bridgeEntry.ts` forwarded it to the background as `requestId`. The background used that page-adjacent id as the sole key for `pendingDecisions` and embedded it directly in the popup URL — a page-controlled identifier was the authoritative capability end to end.
2. `DECISION_MADE` resolved purely by `pendingDecisions.get(requestId)?.resolve(...)` — no sender, tab, frame, or window check at all.
3. `pendingDecisions` was an in-memory `Map`; a worker restart mid-review silently dropped it, and `DEFAULT_TIMEOUT_MS` was defined but never referenced.
4. There was no `chrome.windows.onRemoved` handler, so closing the popup hung the dApp's promise indefinitely, and `chrome.windows.create` was called without a callback, so a creation failure was unobservable.
5. Nothing bounded concurrent pending requests, so a malicious page could open unbounded popups.

Two duplicate `requestOutcome()` implementations (Freighter and Albedo) also had no page-side deadline, so a missing/stale bridge (e.g. after an extension update) could hang the page's promise forever.

## Decision drivers

- A decision must be bound to one transaction digest, tab, frame, document, adapter, and review window — not a bare id.
- A page-controlled identifier must never be an authoritative capability.
- The first valid terminal transition wins; replay must be a no-op, not an error and not a re-release.
- A worker restart must not release a cancelled request or lose a completed decision, and must not need to re-run any work that already committed.
- Popup close, popup-creation failure, tab navigation/closure, and timeout must all settle deterministically and quickly.
- Keep the existing message names/shapes where they already work (`DECISION_MADE`, `GET_REVIEW`) and change *authority*, not vocabulary, to keep the diff reviewable and avoid touching the page-visible Freighter/Albedo protocols at all.

## Considered options

### Option A: Patch the existing map (add sender checks, add a timeout, add `windows.onRemoved`)

This closes individual gaps but leaves the root problem: the background still has no source of truth beyond a live JS closure. A worker restart during review is still unrecoverable, because the fix would still be "hold the whole review open behind one message port," which is exactly what makes worker suspension dangerous in the first place.

### Option B: Versioned protocol + durable state machine, with an opaque extension-generated capability doubling as the request id

Separate the page/bridge correlation id (`localId`, never forwarded past the bridge) from a background-generated `requestId` that is the only authoritative identifier. Persist a serializable projection of pending-request state to `chrome.storage.session` (memory-only, cleared on browser close — same mechanism already used for protection state) *before* opening any UI. Replace the single blocking `SIGN_REQUEST` → decision round trip with two phases: an immediate `SIGN_ACK`/`SIGN_REJECTED` that closes the first message port quickly, followed by a `AWAIT_OUTCOME` resume/status handshake the bridge can retry indefinitely (with backoff) against a durable answer, so a worker restart mid-review is invisible to the bridge beyond one retry.

### Option C: A separate opaque capability token distinct from the request id

Scope C ("pass only an opaque capability in the review URL") could be read as requiring a third identifier beyond `requestId`. We chose not to introduce one: `requestId` is already background-generated, high-entropy, never sent to the page, and length-bounded — it already satisfies "opaque, not page-controlled." Adding a second token would double the state to track for no additional guarantee. This is a deliberate simplification, called out explicitly rather than left implicit.

## Decision

Use option B, with the option C simplification.

**Versioned protocol** (`src/intercept/protocol.ts`, `src/background/messageValidation.ts`): every runtime message carries `protocolVersion`; a mismatch gets a typed `SIGN_REJECTED { reason: 'protocol-incompatible' }`, never a silent bypass. `SIGN_REQUEST` has no `requestId` field at all — the validator rejects a message that includes one, so a page cannot even attempt to smuggle an authoritative id in.

**State machine** (`src/signing/pendingRequestState.ts`, pure, mirrors `src/protection/protectionState.ts`'s existing split of pure state from `chrome.*` wiring): `received → validating → assessing → awaiting_review → {proceed | cancel | expired | failed}`. Terminal states are sticky — `applyTransition` treats a repeat of the *same* terminal state as an idempotent no-op (replay is safe) and rejects any *different* terminal transition once settled (first valid terminal transition wins). Terminal records are kept as tombstones for `TOMBSTONE_TTL_MS` so a retried `AWAIT_OUTCOME` or a duplicate `DECISION_MADE` resolves from cache instead of hitting "unknown request."

**Durable pending repository**: `background.ts` persists the record (not the resolver — resolvers cannot survive suspension) to `chrome.storage.session` before any decode/scoring/UI work. On restart, `restorePendingRequests()` reloads it, settling anything already past its deadline. `handleAwaitOutcome` is the resume handshake: it always answers from durable state, so it behaves identically whether the record was created this worker lifetime or restored from a previous one — no special-casing needed.

**Trusted review capability**: the popup URL carries only `requestId`. `windowId` is bound on first legitimate contact (TOFU) from `sender.tab.windowId` — safe because `requestId` is the actual secret (unguessable, never page-visible), so only a page holding the correct popup URL can reach that code path at all. Every later `GET_REVIEW`/`DECISION_MADE` must match the bound `windowId` exactly; a mismatch is a silent no-op (no review content, no decision) rather than an error that would confirm the request's existence to a prober.

**Failure and concurrency semantics**: `chrome.windows.onRemoved` settles an open request as `cancel`. `chrome.windows.create`'s callback is now used (previously ignored) to detect creation failure (`chrome.runtime.lastError`) and settle `failed`. The existing `chrome.tabs.onUpdated`/`onRemoved` listeners (already used for protection-state invalidation) are extended to also cancel pending signing requests for that tab. `admissionCheck` enforces `MAX_PENDING_PER_FRAME` (5) and `MAX_PENDING_GLOBAL` (50) *before* a popup is created. Deadlines are layered — background's `REVIEW_DEADLINE_MS` (90s) is authoritative and checked eagerly at every touchpoint, not solely via a timer; the bridge's `BRIDGE_FALLBACK_DEADLINE_MS` (100s) covers a missing/unresponsive background; the page's `PAGE_DEADLINE_MS` (120s) covers a missing/unresponsive bridge.

**Compatibility**: a version mismatch produces a typed rejection. Missing `sender.documentId` (older Chrome) is recorded as `documentBound: false` and falls back to tab/frame-only binding — a reduced-but-still-checked guarantee, not silent bypass.

## Consequences

### Positive

- Every non-negotiable invariant in the source issue is now enforced by code, not by convention: digest/tab/frame/document/adapter/window binding, replay-as-no-op, restart survival, deterministic settlement, bounded state.
- `mainWorldEntry.ts`'s and `albedoMainWorldEntry.ts`'s duplicated `requestOutcome()` helper is now shared (`src/intercept/requestOutcome.ts`), removing ~40 lines of duplication and adding the page-side deadline once instead of twice.
- `DEFAULT_TIMEOUT_MS` is now the real, wired-up deadline.

### Negative

- Review content (XDR-derived facts) is intentionally *not* persisted to `chrome.storage.session` — only the pending-request record is. A worker restart during an open review therefore preserves the request's identity/binding/deadline (so it settles safely) but not necessarily its displayed content if the popup needs to re-fetch. See Known Gaps in the PR description.
- Content-script bundle budgets (`scripts/build-extension.mjs`) were raised (mainWorld.js 5.0→5.5 KB, albedoMainWorld.js 6.0→6.5 KB, bridge.js 4.0→5.5 KB) to accommodate the shared helper and the resume/retry loop. Confirmed via `esbuild`'s bundle output that the growth is real code (esbuild strips comments during bundling regardless of the `minify` setting), not incidental bloat.

### Neutral or follow-up work

- Full adversarial coverage (forced service-worker termination via CDP, 1,000-concurrent-request load test, non-Chromium `documentId`-less browser matrix) is out of scope for this PR; see Known Gaps.

## Security and privacy considerations

XDR and review content remain extension-internal; the popup URL still carries only an opaque, background-generated id (never review content, never a page-supplied value). `chrome.storage.session` is memory-only and cleared on browser close, consistent with the existing protection-state persistence and ADR-0003's XDR-out-of-URL decision. Fixed alongside this change: `InterceptView` previously fell back to a URL-supplied `score=0` ("low risk") when review data failed to load — a real, if narrow, "predictable degradation" violation (threat-model.md objective 7) that a restart-survival feature would otherwise make easier to hit. It now fails closed to a reject-only state.

## Validation

Unit: `src/signing/pendingRequestState.test.ts` (state machine, admission control, tombstone pruning, adversarial storage-deserialization), `src/background/background.test.ts` (26 tests covering the full protocol including wrong-window rejection, popup-close, popup-creation-failure, worker-restart resume, replay-is-a-no-op, admission limits, tab invalidation), `src/intercept/awaitOutcome.test.ts` (resume/backoff/deadline logic, DI-based, no real timers), `src/intercept/requestOutcome.test.ts`, `src/background/messageValidation.test.ts`. E2E (`e2e/signTransaction.spec.ts`, real Chromium): all 6 pre-existing scenarios plus 2 new ones — popup close settles cancel without hanging the dApp, and two concurrent requests from the same page open two popups and settle independently without colliding. `npm run lint`, `npm run typecheck`, `npm run test:coverage` (92.25%/83.67%/90.96%/92.25%, threshold 90/80/80/90), `npm run validate:manifest`, and `npm run build` all pass on a clean `npm ci`.

## Revisit criteria

Revisit when: a live/CDP-based forced-worker-termination test harness becomes available in CI (close the "worker restart preserves review content" gap for real, not just at the identity/binding layer); a load-testing harness for the 1,000-concurrent-request and 50-global-admission acceptance criteria is added; a browser without `sender.documentId` support needs to be supported in practice (currently only unit-tested as a fallback path); or an external security review of this ADR identifies a binding this design does not cover.
