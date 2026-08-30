# Gryd Lock Threat Model

- **Status:** Living document
- **Applies to:** extension version `0.1.0` and current `main`
- **Last reviewed:** 2026-08-30

This document describes the security properties of the current Freighter-first implementation. It separates intended guarantees from assumptions, known limitations, and hardening work that is still open.

## Executive summary

Gryd Lock attempts to intercept a Freighter `SUBMIT_TRANSACTION` request before Freighter receives it, build a bounded, versioned local review of the unsigned Stellar transaction, optionally obtain account-target risk evidence, and show the user a warning. Every parsed operation is represented as understood, partial, or opaque. The user can proceed or cancel. On proceed, the original request is re-posted for Freighter; malformed, over-limit, partial, and opaque inputs are never silently shown as green.

The extension is an advisory layer, not a wallet, signer, transaction firewall, oracle, antivirus product, or guarantee that a destination is safe. It does not hold private keys and cannot secure a compromised wallet, browser, operating system, dApp, or risk-data source.

The current build also has known hardening gaps. In particular, the page-visible internal `postMessage` protocol is not yet origin-authenticated, interception is registration-order dependent, and the manifest currently injects scripts on `<all_urls>`. These gaps are tracked in public issues and are not presented as solved controls.

As of the one-shot signing protocol (ADR-0004), pending sign-decision state is durable (`chrome.storage.session`, memory-only) rather than in-memory-only, and the background — not the page-visible `postMessage` correlation id — generates the sole authoritative request identifier. See ADR-0004 and the risk register below for what changed and what remains open.

## Security objectives

Gryd Lock aims to preserve the following properties:

1. **Review-before-signing:** when interception succeeds, the warning is displayed before the intercepted request is passed to Freighter.
2. **Request integrity:** proceeding should re-dispatch the original wallet request without changing its XDR, wallet fields, or message identifier, apart from Gryd Lock's internal reviewed marker.
3. **Cancellation integrity:** a user-selected cancel outcome should prevent the intercepted request from being forwarded to Freighter.
4. **Display integrity:** the network-bound XDR digest, envelope, ordered operations, static facts, findings, evidence, and tier shown to the user should correspond to the same pending request that will be released or cancelled.
5. **Decision binding:** a proceed/cancel decision should resolve only the request whose review popup produced that decision.
6. **No key custody:** Gryd Lock should never request, receive, store, or transmit wallet seed phrases or private signing keys.
7. **Predictable degradation:** malformed, unsupported, opaque, or indeterminate transaction semantics should not be silently misrepresented as low risk. The current product choice is to present a bounded incomplete review or cancel when no safe bounded review can be built.
8. **Finite interruption:** failures in decoding, scoring, popup handling, or MV3 lifecycle should not hang the dApp's signing request indefinitely.
9. **Least privilege:** injected scripts, host access, extension pages, and dependencies should be limited to what the review flow requires.

Not every objective is fully enforced by the current code. The risk register below distinguishes current controls from planned mitigations.

## Assets

### Primary assets

- the user's opportunity to review a pending transaction before signing;
- the integrity of the transaction context shown in the warning;
- the integrity of the user's proceed/cancel decision;
- the continuity and recoverability of the dApp signing flow;
- the credibility of the four-tier warning system;
- the official extension build and update path.

### Sensitive data handled

- unsigned transaction XDR;
- local review facts: network-bound digest, envelope sources, memo, amounts, assets, paths, typed targets, and semantic findings;
- optional account-target risk evidence and aggregated tier;
- per-request identifiers and user decisions.

The current stub score is computed locally. A future network-backed oracle may learn the destination address and request timing unless a privacy-preserving design is introduced and documented.

### Assets Gryd Lock does not hold

- wallet seed phrases or private keys;
- signed transaction secrets beyond what may pass through Freighter's own page protocol;
- custody of user funds;
- authoritative identity or fraud labels.

## Actors and dependencies

- **User:** reviews the warning and chooses proceed or cancel.
- **dApp/page:** creates the Freighter signing request. It may be honest, buggy, compromised, or malicious.
- **Freighter:** owns signing authorization and private keys. Gryd Lock assumes the installed wallet behaves according to its protocol.
- **MAIN-world interceptor:** page-context script that observes Freighter request messages and can stop propagation.
- **Isolated-world bridge:** content script with `chrome.runtime` access that relays messages between the page and extension.
- **MV3 background service worker:** builds bounded reviews, obtains account-target evidence, tracks pending decisions, and opens review windows.
- **Warning popup:** retrieves worker-resident review data by request ID and sends the user's decision.
- **Oracle adapter:** currently a deterministic local stub; a future implementation will be an external trust and availability dependency.
- **Browser and extension platform:** enforces isolation, permissions, extension URLs, runtime messaging, and service-worker lifecycle.

## Trust boundaries and data flow

### Boundary 1: dApp and other page scripts → MAIN world

The page and `mainWorldEntry.ts` share the same JavaScript world and `window` message bus. Page scripts are untrusted and can observe or emit page-level messages. Gryd Lock currently recognizes a Freighter request by source string, type, `messageId`, XDR shape, and an internal reviewed marker.

**Important:** `event.source === window` does not distinguish the legitimate dApp or Freighter from another script in the same page. The internal Gryd Lock message protocol is visible to page scripts.

### Boundary 2: MAIN world ↔ isolated-world bridge

The interceptor posts `{ type, protocolVersion, localId, xdr, adapter }` to `window` (`WINDOW_REQUEST_TYPE`, target origin `'*'`); `bridgeEntry.ts` relays the XDR through `chrome.runtime.sendMessage` as a `SIGN_REQUEST`. `localId` is a same-window postMessage correlation token only: as of ADR-0004, `bridgeEntry.ts` never forwards it to the background, and the background never sees or trusts it. The background generates its own `requestId` (returned in `SIGN_ACK`) and that is the only identifier ever treated as authoritative for pending state or popup URLs.

Messages are still not cryptographically authenticated or bound to an isolated-world session secret, and outbound internal messages still use `'*'` for the initial request (the response leg uses the resolved page origin). A page script sharing `window` can still observe this traffic and could, at most, forge a *request* (which only causes an unwanted extra review popup, gated by the per-frame/global admission limits in ADR-0004) — it cannot forge a *decision*, since decisions are bound to the background-generated `requestId` and the popup's own `windowId`, neither of which the page ever sees. Origin authentication for the request leg itself remains open and is tracked in issue `#1`.

### Boundary 3: isolated world → MV3 background service worker

`chrome.runtime` provides an extension-controlled channel. As of ADR-0004, the background validates message shape *and* protocol version (a mismatch gets a typed `SIGN_REJECTED`, not a silent bypass) and uses `sender.tab.id`/`sender.frameId`/`sender.documentId` to bind every pending sign request to its originating tab/frame/document; a tab closing or navigating away invalidates its pending requests (`chrome.tabs.onUpdated`/`onRemoved`). Per-frame and global admission limits (`MAX_PENDING_PER_FRAME`, `MAX_PENDING_GLOBAL` in `src/signing/pendingRequestState.ts`) bound how many concurrent requests a single frame or the whole extension will admit before opening a popup.

### Boundary 4: background service worker → warning popup

The background worker creates an extension popup URL containing only `mode=intercept` and an opaque, background-generated `requestId`. The popup requests the worker-resident review over extension runtime messaging (`GET_REVIEW`) and sends a `DECISION_MADE` runtime message to resolve it.

React's default escaping reduces direct HTML injection risk. XDR, memos, amounts, sources, targets, scores, and findings are absent from the URL; bounded rendering limits apply to XDR, operations, facts, rendered values, and Soroban authorization traversal. As of ADR-0004: the popup's own `windowId` (from `chrome.windows.create`) is bound to the pending request on first legitimate contact and checked on every subsequent `GET_REVIEW`/`DECISION_MADE`, so a copied review URL opened in a different window reveals no review content and grants no decision authority; a decision is only honored while the request is in the `awaiting_review` state, so a replayed or premature `DECISION_MADE` is a no-op; closing the popup (`chrome.windows.onRemoved`) or a popup-creation failure both settle the request deterministically (cancelled/failed) instead of hanging; and pending-request identity/binding/deadline state is durable (`chrome.storage.session`) across a worker restart, so a restart mid-review does not lose the ability to resolve exactly once. Review *content* itself is not persisted to storage — only the pending-request record is — so a worker restart can still leave a reopened/reloaded popup unable to redisplay the review (see ADR-0004 Known Gaps); the extension fails closed (a reject-only state) rather than falling back to a misleading default in that case.

### Boundary 5: background service worker → oracle adapter

The current adapter is a local stub and is not evidence of destination safety. A future remote adapter introduces network confidentiality, authentication, integrity, availability, freshness, privacy, and false-positive/false-negative risks. A timeout and defined fallback are tracked in issue `#12`.

### Boundary 6: MAIN world → Freighter

After `proceed` or `allow`, Gryd Lock re-posts the captured request with `__grydlockReviewed: true` so it is not intercepted again. Freighter remains responsible for displaying its own signing UI, authenticating the user, and signing the transaction.

Gryd Lock assumes Freighter signs the transaction the user and dApp expect. A compromised Freighter can ignore, alter, or replace the request after Gryd Lock review.

## Protected scenarios

When all dependencies and assumptions hold, Gryd Lock is intended to help with:

- a dApp asking Freighter to sign a transaction whose XDR can be boundedly decoded;
- presenting complete static transaction semantics and optional account-target risk context before the request is released to Freighter;
- helping a user notice a known or suspected fraudulent destination;
- allowing the user to stop the intercepted request before Freighter receives it;
- preserving the original request when the user proceeds;
- avoiding private-key custody by leaving signing entirely to Freighter.

The warning is only one decision signal. A low score is not proof of safety, and a high score is not proof of fraud.

## Explicit non-goals and unprotected scenarios

Gryd Lock does not currently protect against:

- a compromised, malicious, counterfeit, or vulnerable Freighter installation;
- a compromised browser, operating system, user profile, or another extension with equivalent privileges;
- the cross-extension registration-order race where Freighter receives a request before Gryd Lock's listener;
- a user disabling, uninstalling, bypassing, or knowingly overriding the extension;
- unsupported wallets and signing flows that do not use the recognized Freighter message protocol;
- inaccurate, stale, manipulated, unavailable, or incomplete oracle data;
- dynamic ledger effects, live Soroban simulation, or application behaviour that cannot be proven from XDR alone;
- social engineering, malicious memo text, deceptive asset branding, or contract/application behavior that destination scoring does not model;
- a review proving an XDR's runtime ledger effects, balances, trustlines, offer state, contract execution, or submission outcome;
- silent failure, hangs, or state loss caused by open lifecycle and timeout issues described below;
- confidentiality from scripts already executing in the same page context; the page can observe page-level traffic and the current internal `postMessage` exchange;
- financial recovery or transaction reversal after a user or wallet signs and submits a transaction.

## Assumptions

- Chrome/Chromium enforces Manifest V3 isolation and extension-origin protections correctly.
- The official extension package corresponds to reviewed source and has not been replaced in the build or distribution pipeline.
- Freighter's external request/response protocol remains compatible with the intercepted message shape.
- `crypto.randomUUID()` is available and generates unpredictable identifiers, while recognizing that the identifier is currently exposed to the page.
- Stellar SDK decoding is correct for the supplied network and supported operation shapes.
- The tier mapping receives a finite score in the expected 0–100 range.
- The user can distinguish the extension popup from page-controlled content and can review the displayed destination meaningfully.
- Future oracle transport will authenticate the service and define score freshness, availability, and fallback behavior before it is treated as production-ready.

## Threat and risk register

| Threat                                                                | Current control                                                                                                                                         | Residual risk / planned mitigation                                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Page script forges or races internal messages                         | Message type checks, `event.source === window`, background-generated (never page-supplied) request ID (ADR-0004)                                        | Same-page scripts share `window` and can still forge a request, gated by admission limits; cannot forge a decision. Origin policy for the request leg remains open (`#1`). |
| Freighter receives request before Gryd Lock                           | MAIN-world listener uses capture mode at `document_start` and stops immediate propagation                                                               | Chrome does not guarantee cross-extension order; add runtime self-test and degraded-protection warning (`#8`).   |
| User closes review popup                                              | `chrome.windows.onRemoved` settles the request as cancelled (ADR-0004)                                                                                   | Resolved.                                                                                                         |
| MV3 worker terminates during review                                   | Pending-request identity/binding/deadline persisted to `chrome.storage.session` before UI opens; `AWAIT_OUTCOME` resume handshake reads durable state (ADR-0004) | Review content itself is not persisted, only the pending-request record; a restart can still leave a reopened popup unable to redisplay the review (fails closed). |
| Malicious dApp floods signing requests                                | Per-frame and global admission limits reject beyond bound before any popup opens (ADR-0004)                                                              | Limits are unit-tested at the boundary; a full 1,000-concurrent-request load test is not yet part of CI.         |
| Malformed or adversarial XDR crashes, hangs, or becomes green         | Bounded XDR/operation/fact/Soroban traversal parsing; malformed or over-limit review cancels; fuzz/property tests                                       | SDK parser and static review still cannot prove runtime effects.                                                 |
| Wrong Stellar network used for decoding                               | The incoming alias or custom passphrase is resolved once, retained in every typed target and the displayed review, and used in the network-bound digest | The extension relies on the wallet/dApp-supplied passphrase; it cannot independently prove the intended network. |
| Attacker-controlled review data exhausts popup or leaks through a URL | Worker-only review storage, opaque background-generated-ID-only popup URL, control-character stripping, and display bounds                              | Request authenticity for the initial page request remains open (Boundary 2); stale/copied-popup risk is resolved by window binding (ADR-0004). |
| Overbroad page access increases attack surface                        | MV3 isolation                                                                                                                                           | Scripts and host permission currently use `<all_urls>`; reduce or justify access (`#5`).                         |
| Oracle stalls signing                                                 | Current local stub resolves quickly                                                                                                                     | Remote adapter needs cancellation, timeout, and explicit fallback (`#12`).                                       |
| Oracle gives a wrong or malicious score                               | Tier mapping displays supplied score                                                                                                                    | Authenticate source, define freshness/provenance, monitor quality, and never describe score as a guarantee.      |
| Dependency or build compromise                                        | Lockfile, lint/type/test/build CI                                                                                                                        | Automate dependency updates and keep CI-gated review (`#46`); protect release credentials and provenance.        |
| Popup or decision is not bound to the originating tab/frame/request   | Request bound to originating tab/frame/document (invalidated on navigation/close) and to the popup's own windowId; first valid terminal transition wins, replay is a no-op (ADR-0004) | Resolved for identity/binding/replay in scope; see ADR-0004 for what remains deferred. |
| User sees false assurance while extension is inactive                 | README documents limitations                                                                                                                             | Add runtime health/self-test UI and explicit degraded states (`#8`).                                             |

Issue references identify planned work; they are not evidence that the mitigation is already deployed.

## Privacy analysis

### Current build

The intercepted unsigned XDR and all review facts remain inside the extension/browser process. The popup URL contains only an opaque request ID; it never contains XDR, sources, memo, amounts, targets, contract IDs, claimable-balance IDs, findings, or scores. The local score stub does not send an account target to a server.

However:

- Gryd Lock injects scripts on all matched pages under the current manifest;
- the MAIN-world and internal page message traffic is visible to scripts on the same page;
- the page-visible MAIN-world protocol still carries XDR to the isolated bridge before it reaches the extension;
- browser debugging, crash reporting, other privileged extensions, or local malware may expose this data.

### Future oracle integration

Before enabling a remote oracle, document:

- exactly which fields leave the browser;
- the legal/operational entity receiving them;
- transport authentication and certificate validation;
- retention, logging, analytics, and deletion behavior;
- whether IP address and timing can be linked to destination queries;
- batching, proxying, private information retrieval, local caching, or other privacy mitigations;
- behavior when the service is unavailable or returns invalid data.

Do not send full XDR when a destination-only query is sufficient.

## Security review requirements for changes

Changes affecting any of the following require explicit security review and normally an ADR:

- page/MAIN-world interception;
- Gryd Lock or Freighter message formats;
- request identifiers, nonces, sender/origin validation, or replay behavior;
- pending-decision storage, timeout, recovery, or concurrency;
- destination/network/XDR parsing;
- popup URL/state transport or decision handling;
- host permissions, content-script matches, web-accessible resources, or CSP;
- oracle transport, authentication, fallback, privacy, or score provenance;
- wallet-adapter abstractions and additional wallet integrations;
- dependency, CI, packaging, signing, or release changes.

Tests should cover negative and adversarial paths, not only the happy path. Real-wallet and browser-lifecycle changes also require manual verification notes.

## Incident response outline

1. Receive the report through the private process in [`SECURITY.md`](../SECURITY.md).
2. Reproduce using synthetic accounts and transactions.
3. Determine affected commits/builds, exploit prerequisites, and whether active exploitation is plausible.
4. Contain distribution or disable a risky integration when necessary.
5. Implement tests that demonstrate the vulnerability and the fix.
6. Run lint, typecheck, tests, build, and manual browser verification appropriate to the issue.
7. Publish an updated build and private advisory guidance.
8. Coordinate public disclosure and credit after users can obtain the fix.
9. Update this threat model, README caveats, and related ADRs when assumptions or boundaries changed.

## Review cadence

Review this document when:

- a live oracle replaces the stub;
- a new wallet adapter is added;
- Chrome permissions or execution contexts change;
- signing state becomes persistent;
- a security issue changes an assumption or control;
- an official extension release is prepared;
- at least once per major release while the project is active.
