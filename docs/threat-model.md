# Gryd Lock Threat Model

- **Status:** Living document
- **Applies to:** extension version `0.1.0` and current `main`
- **Last reviewed:** 2026-07-18

This document describes the security properties of the current Freighter-first implementation. It separates intended guarantees from assumptions, known limitations, and hardening work that is still open.

## Executive summary

Gryd Lock attempts to intercept a Freighter `SUBMIT_TRANSACTION` request before Freighter receives it, decode the unsigned Stellar transaction, extract one destination, obtain a risk score, and show the user a warning. The user can proceed or cancel. On proceed or an explicit `allow` outcome, the original request is re-posted for Freighter; on cancel, Gryd Lock synthesizes a rejection response.

The extension is an advisory layer, not a wallet, signer, transaction firewall, oracle, antivirus product, or guarantee that a destination is safe. It does not hold private keys and cannot secure a compromised wallet, browser, operating system, dApp, or risk-data source.

The current build also has known hardening gaps. In particular, the page-visible internal `postMessage` protocol is not yet origin- or session-authenticated, interception is registration-order dependent, pending decisions are stored only in memory, and the manifest currently injects scripts on `<all_urls>`. These gaps are tracked in public issues and are not presented as solved controls.

## Security objectives

Gryd Lock aims to preserve the following properties:

1. **Review-before-signing:** when interception succeeds, the warning is displayed before the intercepted request is passed to Freighter.
2. **Request integrity:** proceeding should re-dispatch the original wallet request without changing its XDR, wallet fields, or message identifier, apart from Gryd Lock's internal reviewed marker.
3. **Cancellation integrity:** a user-selected cancel outcome should prevent the intercepted request from being forwarded to Freighter.
4. **Display integrity:** the destination, asset, score, and tier shown to the user should correspond to the same pending request that will be released or cancelled.
5. **Decision binding:** a proceed/cancel decision should resolve only the request whose review popup produced that decision.
6. **No key custody:** Gryd Lock should never request, receive, store, or transmit wallet seed phrases or private signing keys.
7. **Predictable degradation:** unsupported or indeterminate transactions should not be silently misrepresented as low risk. The current product choice is to return `allow` when no single destination can be determined.
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
- extracted destination address and optional asset label;
- network metadata when available in the wallet request;
- risk score and tier;
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
- **MV3 background service worker:** decodes XDR, obtains scores, tracks pending decisions, and opens review windows.
- **Warning popup:** displays review data and sends the user's decision.
- **Oracle adapter:** currently a deterministic local stub; a future implementation will be an external trust and availability dependency.
- **Browser and extension platform:** enforces isolation, permissions, extension URLs, runtime messaging, and service-worker lifecycle.

## Trust boundaries and data flow

### Boundary 1: dApp and other page scripts → MAIN world

The page and `mainWorldEntry.ts` share the same JavaScript world and `window` message bus. Page scripts are untrusted and can observe or emit page-level messages. Gryd Lock currently recognizes a Freighter request by source string, type, `messageId`, XDR shape, and an internal reviewed marker.

**Important:** `event.source === window` does not distinguish the legitimate dApp or Freighter from another script in the same page. The internal Gryd Lock message protocol is visible to page scripts.

### Boundary 2: MAIN world ↔ isolated-world bridge

The interceptor posts `{ type, requestId, xdr }` to `window`; `bridgeEntry.ts` relays it through `chrome.runtime.sendMessage`. The response returns over the same page-visible bus.

Current messages are not cryptographically authenticated or bound to an isolated-world session secret. Outbound internal messages also use `'*'` in some paths. Origin validation and session binding are tracked in issues `#1` and `#4`.

### Boundary 3: isolated world → MV3 background service worker

`chrome.runtime` provides an extension-controlled channel, but the background listener currently trusts the typed shape of incoming messages and does not use sender metadata to enforce an expected content script, extension page, tab, or frame. A future hardening pass should validate message fields and sender context before creating state or resolving decisions.

### Boundary 4: background service worker → warning popup

The background worker creates an extension popup URL containing `requestId`, destination, asset, and score as query parameters. React renders the values and sends a `DECISION_MADE` runtime message.

React's default escaping reduces direct HTML injection risk, but URL length, character set, request authenticity, stale popup, and decision-binding risks remain. Input bounding is tracked in issue `#9`; an explicit extension-page CSP is tracked in issue `#6`.

### Boundary 5: background service worker → oracle adapter

The current adapter is a local stub and is not evidence of destination safety. A future remote adapter introduces network confidentiality, authentication, integrity, availability, freshness, privacy, and false-positive/false-negative risks. A timeout and defined fallback are tracked in issue `#12`.

### Boundary 6: MAIN world → Freighter

After `proceed` or `allow`, Gryd Lock re-posts the captured request with `__grydlockReviewed: true` so it is not intercepted again. Freighter remains responsible for displaying its own signing UI, authenticating the user, and signing the transaction.

Gryd Lock assumes Freighter signs the transaction the user and dApp expect. A compromised Freighter can ignore, alter, or replace the request after Gryd Lock review.

## Protected scenarios

When all dependencies and assumptions hold, Gryd Lock is intended to help with:

- a dApp asking Freighter to sign a transaction with one detectable destination;
- presenting destination-based risk context before the request is released to Freighter;
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
- destination risks that are not visible from the extracted destination address;
- social engineering, malicious memo text, deceptive asset branding, or contract/application behavior that destination scoring does not model;
- transactions with no supported destination-bearing operation or with multiple distinct destinations; the current implementation returns `allow`;
- transaction semantics not represented in the warning, including operation ordering, amounts, authorization changes, trustlines, sponsorship, or path details;
- mainnet/testnet confusion until network metadata is carried through the full pipeline as tracked in issue `#10`;
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

| Threat | Current control | Residual risk / planned mitigation |
| --- | --- | --- |
| Page script forges or races internal messages | Message type checks, `event.source === window`, random request ID | Same-page scripts share `window`; add origin policy and isolated session binding (`#1`, `#4`). |
| Freighter receives request before Gryd Lock | MAIN-world listener uses capture mode at `document_start` and stops immediate propagation | Chrome does not guarantee cross-extension order; add runtime self-test and degraded-protection warning (`#8`). |
| User closes review popup | Decision map waits for `DECISION_MADE` | Request may hang forever; handle window removal and timeout (`#2`). |
| MV3 worker terminates during review | None beyond browser runtime behavior | In-memory resolver is lost; persist recoverable metadata and fail safely (`#3`). |
| Malicious dApp floods signing requests | Each request receives a random ID and separate popup | Unbounded windows and map growth permit client-side denial of service; add queue and concurrency limits (`#7`). |
| Malformed or adversarial XDR crashes or confuses decoding | SDK parser, null outcome, unit tests | Expand defensive parsing and fuzz/property tests (`#23`). |
| Wrong Stellar network used for decoding | Decoder currently defaults to testnet | Carry and validate network/passphrase through the protocol (`#10`). |
| Attacker-controlled destination/asset breaks popup or URL | `URLSearchParams` encoding and React escaping | Add length/character bounds and explicit extension CSP (`#9`, `#6`). |
| Overbroad page access increases attack surface | MV3 isolation | Scripts and host permission currently use `<all_urls>`; reduce or justify access (`#5`). |
| Oracle stalls signing | Current local stub resolves quickly | Remote adapter needs cancellation, timeout, and explicit fallback (`#12`). |
| Oracle gives a wrong or malicious score | Tier mapping displays supplied score | Authenticate source, define freshness/provenance, monitor quality, and never describe score as a guarantee. |
| Dependency or build compromise | Lockfile, lint/type/test/build CI | Automate dependency updates and keep CI-gated review (`#46`); protect release credentials and provenance. |
| Popup or decision is not bound to the originating tab/frame/request | Request ID map | Add sender/tab/frame validation, session binding, stale-popup rejection, and one-shot decision semantics. |
| User sees false assurance while extension is inactive | README documents limitations | Add runtime health/self-test UI and explicit degraded states (`#8`). |

Issue references identify planned work; they are not evidence that the mitigation is already deployed.

## Privacy analysis

### Current build

The intercepted unsigned XDR, destination, asset label, score, request ID, and decision remain inside the page/extension/browser process. The local score stub does not send the destination to a server.

However:

- Gryd Lock injects scripts on all matched pages under the current manifest;
- the MAIN-world and internal page message traffic is visible to scripts on the same page;
- destination, asset, score, and request ID are placed in an extension popup URL;
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
