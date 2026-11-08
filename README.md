# Gryd Lock 🔒

[![CI](https://github.com/Gryd-lock/grydlock-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/Gryd-lock/grydlock-extension/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)](<>)
[![Built with TypeScript](https://img.shields.io/badge/Built%20with-TypeScript-3178c6?logo=typescript&logoColor=white)](<>)
[![Status: Early Build](https://img.shields.io/badge/status-early%20build-orange)](<>)

**Warns you before you sign a risky Stellar transaction — and says "unknown" instead of guessing.**

## Try it

You need Node 20+ and a Chromium browser (Chrome, Brave or Edge). After `npm ci`, the steps take
about 30 seconds and need no wallet, account or network access.

```bash
npm ci && npm run build   # builds the unpacked extension into dist/
npm run demo              # local test dApp on http://127.0.0.1:5174
```

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick
   `dist/`.
2. Open <http://127.0.0.1:5174> and click **Send** next to _Payment_. Gryd Lock intercepts the
   Freighter `SUBMIT_TRANSACTION` request and opens its review. With the default settings it shows
   **Unknown risk**: no score source is configured, so it reviews the transaction but does not
   invent a score.
3. Open the extension's **Options** page, set _Destination risk score source_ to **Testkit
   fixtures (testnet only)**, and click **Save**. Send _Payment_ again to get **High risk (score 55)**, or _Path payment_ to get **Critical risk (score 92)**. **Cancel** returns a wallet
   rejection to the page. **Proceed** forwards the request to the wallet. The demo page simulates
   the wallet reply unless you untick that option.

<!-- GIF placeholder: record steps 2–3 at 800px wide and save as docs/media/try-it.gif, then
     replace this comment with: ![Gryd Lock warning on the demo dApp](docs/media/try-it.gif) -->

_Walkthrough GIF: not recorded yet._

The demo transactions are unsigned testnet XDR from
[`grydlock-testkit`](https://github.com/Gryd-lock/grydlock-testkit). All of their addresses are
synthetic.

## Status

| Area                                                                | Status                 | Notes                                                                                                                                                                                                          |
| ------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Freighter interception (`SUBMIT_TRANSACTION` postMessage)           | ✅ Works               | Covered by Playwright E2E against the built extension                                                                                                                                                          |
| Albedo interception (popup `tx` / `pay` intents)                    | ✅ Works               | Implicit-flow and SEP-0007 intents are not intercepted                                                                                                                                                         |
| Local transaction review (every operation, fee-bump, memo, Soroban) | ✅ Works               | Each operation is labelled understood, partial or opaque                                                                                                                                                       |
| Four-tier warning with Cancel / Proceed and confirmation gates      | ✅ Works               | Plus an **Unknown** state when no score exists                                                                                                                                                                 |
| Score source: Off (default)                                         | ✅ Works               | Shows the review only. No network requests                                                                                                                                                                     |
| Score source: Testkit fixtures                                      | ✅ Works, testnet only | Synthetic scores from `grydlock-testkit`. Refused for mainnet and any non-testnet passphrase                                                                                                                   |
| Score source: Soroban oracle                                        | 🧪 Experimental        | Real RPC transport through [`grydlock-oracle-adapter`](https://github.com/Gryd-lock/grydlock-oracle-adapter)'s `SorobanOracle`. **No oracle contract is deployed**, so lookups report "assessment unavailable" |
| Protection-status toolbar popup                                     | ✅ Works               | Per-tab handshake health. It cannot prove listener ordering against other extensions                                                                                                                           |
| Decision history (local only)                                       | ⚠️ Partial             | Records only decisions on scored destinations, so with scoring off nothing is recorded                                                                                                                         |
| Asset-level checks (scam trustlines, asset issuers)                 | ❌ Not built           | `changeTrust` to a scam asset is flagged only for incomplete coverage                                                                                                                                          |
| xBull / Lobstr                                                      | ❌ Not built           |                                                                                                                                                                                                                |
| Firefox                                                             | ❌ Not built           | Feasibility in [spike 0117](docs/spikes/0117-cross-browser-extension-compatibility.md)                                                                                                                         |
| Localisation                                                        | ❌ Not built           | English only                                                                                                                                                                                                   |
| Chrome Web Store listing                                            | ❌ Not published       | Install unpacked, or from a [GitHub Release](https://github.com/Gryd-lock/grydlock-extension/releases) zip                                                                                                     |

Background reading: the [design study](docs/design-study.md) (threat model, research questions,
evaluation plan) and the [threat model](docs/threat-model.md).

## Overview

This runs entirely in the user's browser. It hooks supported wallet signing flows, builds a
versioned local review of the complete pending transaction, obtains optional risk evidence only
for typed account targets, and renders a four-tier warning. A bounded review lets the user decide;
malformed or over-limit XDR is cancelled rather than forwarded without an honest review. The toolbar
first reports whether the current tab has recently completed the extension's non-financial health
check; it never calls a site or wallet flow protected merely because the extension is installed.

For detailed information on data handling, data protection, and our no-telemetry architecture, see [PRIVACY.md](PRIVACY.md).

> **Status:** Early build. See [Status](#status) for exactly what works, what is
> experimental, and what is not built.

## What it does

```
User initiates a transaction in a Stellar wallet
        │
        ▼
Extension intercepts the unsigned transaction (Freighter signing flow)
        │
        ▼
Decode the transaction XDR → build a complete local review
        │
        ▼
Classify each operation as understood, partial, or opaque
        │
        ▼
Request optional 0–100 risk evidence for typed account targets
(only if a score source is configured — default is off)
        │
        ▼
Aggregate semantic findings, incomplete coverage, and evidence → show the warning
        │
        ▼
User proceeds or cancels — the extension never blocks
```

### Warning tiers

| Score  | Tier     | Behaviour                                                              |
| ------ | -------- | ---------------------------------------------------------------------- |
| 0–20   | Low      | Green indicator, proceed                                               |
| 21–50  | Elevated | Soft warning                                                           |
| 51–75  | High     | Strong warning, checkbox enables proceed                               |
| 76–100 | Critical | Recommend abort, type `CRITICAL` to proceed                            |
| none   | Unknown  | No destination score exists, and the review found nothing more serious |

The shown tier is the **worst** of the destination score and the semantic review findings. For
example, a signer change or an opaque Soroban call can raise a warning to High or Critical with no
score at all. A review is shown as **Low** only when every scoreable destination has a score.
Otherwise it is **Unknown**.

## Why Freighter First

Stellar has no universal injected wallet provider — each wallet exposes its own signing API, so interception is per-wallet, not global. Gryd Lock targets **Freighter** first (the most widely used browser wallet), proves the interception pattern, then generalises to xBull, Albedo, and Lobstr.

## Albedo Interception

Albedo is a web-based signer at `albedo.link` — it has no browser extension of its own that Gryd Lock can hook. Instead, the `@albedo-link/intent` npm library (used by dApps) opens a cross-origin popup via `window.open('https://albedo.link/confirm', 'auth.albedo.link', ...)` and communicates with it using `postMessage`.

**Interception strategy** (`src/intercept/albedoMainWorldEntry.ts`, MAIN world):

```
dApp calls albedo.tx({ xdr, network }) via @albedo-link/intent
        │
        ▼
albedo-intent calls window.open('https://albedo.link/confirm', 'auth.albedo.link', ...)
        │
        ▼
albedoMainWorldEntry.ts monkey-patches window.open at document_start
  └─▶ detects target === 'auth.albedo.link'
  └─▶ opens the real Albedo popup
  └─▶ returns a Proxy wrapping the real popup window
        │
        ▼
albedo-intent calls proxy.postMessage({ intent: 'tx', xdr, network, __reqid, ... })
        │
        ▼
Proxy intercepts first postMessage for 'tx' / 'pay' intents with an xdr field
  └─▶ routes xdr through GRYDLOCK_REQUEST_OUTCOME → bridge → background (same path as Freighter)
  └─▶ background decodes XDR, scores destinations, opens warning popup
        │
        ▼
'cancel'            → real popup closed; synthetic albedoIntentResult error posted back
                       to the dApp (code -4, matching Albedo's standard rejection shape)
'allow' / 'proceed' → original postMessage forwarded to the real Albedo popup; user signs
                       in Albedo normally
```

**What is not intercepted:**

- **Implicit-flow intents** — these bypass the popup (they send directly via an iframe/session token established earlier). The XDR is not visible at the `window.open` layer.
- **Non-XDR intents** (`public_key`, `sign_message`, `trust`, `exchange`) — no transaction destination to score; passed through unmodified.
- **SEP-0007 link handler** (Albedo browser extension variant) — uses a page redirect rather than a popup; different surface not covered by this adapter.

**Manual verification:** Load a dApp that calls `albedo.tx({ xdr: '...', network: 'testnet' })`, open the extension's dev popup first to confirm the bridge is alive, then trigger the Albedo signing flow. The Gryd Lock warning should appear before the Albedo confirmation dialog receives the intent payload.

## Accessibility

The warning is a modal `role="dialog"` labelled by its tier heading, which sits in an
`aria-live="assertive"` region so screen readers (VoiceOver, NVDA) announce the tier on open. Each
tier also has a distinct icon, so colour is never the only signal, and review findings are
rendered in a `role="alert"` list. Keyboard behaviour is described under
[How the Pieces Connect](#how-the-pieces-connect). `jest-axe` checks run in the popup tests.

## Tech Stack

- **TypeScript** — extension logic
- **React** — warning UI in the popup
- **Stellar SDK (JS)** — decoding the unsigned transaction
- **Manifest V3** — Chrome / Brave / Edge extension format

The risk score itself comes through [`grydlock-oracle-adapter`](https://github.com/Gryd-lock/grydlock-oracle-adapter)
(`RiskOracle`, `StubOracle`, `SorobanOracle`, cache, timeout and circuit-breaker middleware). This
repo holds no scoring logic. The package is installed from a commit-pinned GitHub tarball and built
in place by `scripts/build-oracle-adapter.mjs` (postinstall), because the upstream repo does not
publish built output yet.

## Project Layout

```
grydlock-extension/
├── manifest.json               # MV3 — popup, background service worker, content scripts
├── demo/                       # Local test dApp (`npm run demo`) serving grydlock-testkit XDR
├── e2e/                        # Playwright E2E against the built extension
├── scripts/
│   ├── build-extension.mjs     # esbuild bundles for background / mainWorld / albedoMainWorld / bridge
│   └── build-oracle-adapter.mjs  # postinstall: builds grydlock-oracle-adapter's dist/
├── src/
│   ├── adapter/                # Score sources on top of grydlock-oracle-adapter + Soroban RPC transport
│   ├── background/             # Service worker: decodes XDR, scores, opens the warning popup
│   ├── decode/                 # XDR → versioned transaction review (Stellar SDK)
│   ├── history/                # Options page: score-source setting, decision history, diagnostics
│   ├── intercept/              # Freighter + Albedo proxies + message-bridge protocol
│   ├── lib/                    # Tier definitions, local decision history storage
│   ├── popup/                  # React warning UI and protection-status toolbar popup
│   ├── review/                 # Review model and the single aggregation/tier policy
│   └── settings/               # Score-source settings: storage, validation, network policy, UI
└── README.md
```

## Decision History

Proceed/cancel decisions on **scored** destinations are recorded locally: destination, asset
(when present), score, tier, decision, and timestamp. Reviews without a score (for example, with
scoring off) are not recorded yet. Open it via the extension's
**Options** page (right-click the toolbar icon → Options, or `chrome://extensions` → Gryd Lock →
Details → Extension options).

Privacy:

- History lives only in `chrome.storage.local` on your device — it is never transmitted anywhere.
- Storage is capped to the most recent 200 decisions; older entries are dropped automatically.
- A **Clear history** button on the page deletes everything at once.

## Protection coverage

The toolbar popup reports a fresh, per-tab health status instead of a placeholder score. A
`protected` result requires a recent MAIN-world → isolated bridge → worker → MAIN-world handshake;
the handshake carries only an ephemeral nonce, adapter name, and protocol version. It never signs,
submits, reads, or exposes a transaction. The popup distinguishes stale, bridge unavailable,
worker unavailable, permission denied, adapter incompatible, unsupported, and unknown states.

This proves Gryd Lock's own execution contexts can communicate, but it cannot prove Chrome will
order it before another extension's listener. That browser limitation remains visible in the UI and
is a real-wallet release gate. Supported adapters and explicit exclusions are in
[protection coverage](docs/protection-coverage.md).

## Transaction review coverage

Before a signing request reaches a wallet, Gryd Lock builds a local, versioned review of the
exact XDR. It shows the exact network passphrase, network-bound digest, envelope/fee source,
memo, ordered operations, static facts, typed targets, and semantic findings. Every SDK
operation is classified as **understood**, **partial**, or **opaque**. Partial and opaque
operations are always shown as incomplete review coverage; they are never presented as a
low-risk assessment.

Only Stellar account targets are eligible for the current destination scorer. Contract IDs,
claimable-balance IDs, and liquidity-pool IDs remain typed local review data and are never
misrepresented as account addresses. Static review does not simulate a transaction or claim to
know ledger-dependent outcomes.

## How the Pieces Connect

**Toolbar click** opens the protection-status panel (`src/popup/ProtectionStatus.tsx`). It
reports per-tab handshake health and never shows a score.

**Real Freighter signing** — `@stellar/freighter-api`'s `signTransaction` doesn't call a global
function; it posts `{ source: 'FREIGHTER_EXTERNAL_MSG_REQUEST', type: 'SUBMIT_TRANSACTION', ... }`
to `window`, and Freighter's own content script replies the same way. That `postMessage` traffic is
the actual interception point:

```
dApp posts { source: FREIGHTER_EXTERNAL_MSG_REQUEST, type: SUBMIT_TRANSACTION, transactionXdr, networkPassphrase }
        │
        ▼
src/intercept/mainWorldEntry.ts   (MAIN world; grabs the request via stopImmediatePropagation()
        │                          before Freighter's own listener sees it)
        │  window.postMessage (Gryd Lock's own internal request/response, separate from Freighter's)
        ▼
src/intercept/bridgeEntry.ts      (isolated world; only place with chrome.* API access;
        │                          generates the real requestId here, never in MAIN world,
        │                          so a page script can't observe it and forge a decision)
        │  chrome.runtime.sendMessage
        ▼
src/background/background.ts      (service worker)
        │
        ├─▶ src/decode/transactionReview.ts → extractTransactionReview(xdr)
        │      retains the exact network-bound digest, ordered operations, static facts,
        │      typed targets, coverage, and semantic findings
        │
        ├─▶ typed account targets looked up via src/adapter/oracleAdapter.ts, using the source
        │      chosen in settings (off by default; fixtures refused off testnet)
        │
        └─▶ shared review policy aggregates semantic findings, incomplete coverage, and evidence
                   │
                   ▼
             src/popup/App.tsx retrieves worker-resident review data by request ID; the popup URL
             contains no XDR, memo, target, amount, score, or semantic detail
                   │  chrome.runtime.sendMessage({ type: 'DECISION_MADE', ... })
                   ▼
        background resolves the pending request by its one-shot request ID → bridge → mainWorld
                   │
                   ▼
        'cancel'            → mainWorld synthesizes a decline FREIGHTER_EXTERNAL_MSG_RESPONSE;
                               Freighter's own listener never sees the request at all
        'proceed' / 'allow' → mainWorld re-posts the original request (tagged so it isn't
                               re-intercepted) for Freighter to handle exactly as it would have
```

- **Registration-order dependent**: this only works if `mainWorldEntry.ts`'s listener registers
  before Freighter's own content script does. Both run at `document_start`, but Chrome does not
  guarantee injection order across different extensions — the same tradeoff every
  postMessage-based wallet-firewall extension accepts.
- **Why the split**: `mainWorldEntry.ts` runs in the page's own JS context (needed to see the
  page's `postMessage` traffic) but has no `chrome.*` API access there; `bridgeEntry.ts` runs
  alongside it in the isolated content-script world and is the only piece that can talk to the
  extension via `chrome.runtime`. Decoding and scoring happen in the background worker rather than
  in `mainWorldEntry.ts` so the Stellar SDK ships once per browser session instead of being
  injected into every page (`mainWorld.js` has a 5.5&nbsp;KB budget enforced by the build; the SDK
  lives in `background.js` instead).
- **Keyboard-first approval**: the warning is an approval dialog for a signing request, so it is
  fully operable without a mouse. `src/popup/TierWarning.tsx` renders as a modal dialog
  (`role="dialog"`, `aria-modal`, labelled by the tier heading) and:
  - focuses **Cancel** on open for every tier — the safe choice is always one keypress away, and a
    High/Critical warning never makes you hunt for focus;
  - traps focus in the popup — Tab and Shift+Tab cycle through its interactive elements and wrap at
    the ends, so focus can't land on browser or extension UI while a decision is pending;
  - treats **Escape** as Cancel, routed through the same `onCancel` path as the button, so an
    intercepted request declines identically however it was dismissed;
  - leaves Enter/Space activation to native `<button>` behaviour rather than re-implementing it.
- **Pure logic**: `src/intercept/resolveOutcome.ts` is the testable core — given a decode function,
  a score function, and a decision function, it returns `'allow' | 'proceed' | 'cancel'` with no
  Chrome APIs involved, so it's covered by ordinary Vitest unit tests.
- **Fail-closed review**: malformed or over-limit XDR returns `cancel`; partial and opaque operations
  are rendered as incomplete coverage and can never be presented as an unqualified low-risk review.
  Static review never claims ledger-dependent effects.
- **Typed targets**: account, contract, claimable-balance, and liquidity-pool identifiers retain the
  exact network passphrase. Only account targets are sent to the destination score source.
  In particular, a claimable-balance ID is local review data, never an account-oracle query.
- **Tests**: `src/decode/transactionReview.test.ts`, `src/decode/sorobanSemantics.test.ts`, and
  `src/intercept/resolveOutcome.test.ts` cover review construction, bounded Soroban analysis,
  score projection, aggregation, malformed XDR, and decisions. Popup tests cover keyboard-accessible
  review rendering and the worker-resident review data flow.

## Security

Report suspected vulnerabilities privately using [SECURITY.md](SECURITY.md). The
[threat model](docs/threat-model.md) documents the extension's trust boundaries, current
guarantees, explicit non-goals, known gaps, and security-hardening roadmap.

`manifest.json` requests `host_permissions: ["<all_urls>"]` and matches `<all_urls>` for its `document_start` content scripts. [docs/permissions.md](docs/permissions.md) documents why, the narrower alternatives considered (`activeTab` + `optional_host_permissions`), and why they were deferred.

## Develop

1. `npm ci` (also builds `grydlock-oracle-adapter` via postinstall)
2. `npm run build`, or `npm run dev` for a Vite dev server for the popup only. The content scripts
   and background worker need a real `chrome://extensions` load.
3. Load `dist/` unpacked (see [Try it](#try-it)) and use `npm run demo` to send test requests.
4. In dev builds, `src/popup/index.html?dev=score&score=60` renders the warning with a slider over
   synthetic scores, for UI work. That route is compiled out of production builds and never calls
   an oracle.

## Quality Gates

```bash
npm run lint              # ESLint
npm run typecheck         # tsc --noEmit
npm run test:coverage     # Vitest + v8 coverage (enforces thresholds)
npm run validate:manifest # MV3 / Chrome Web Store policy checks
npm run build             # tsc -b && vite build && node scripts/build-extension.mjs
npm run test:visual       # Playwright visual regression snapshots
npm run test:e2e          # Playwright E2E: built extension + demo dApp + testkit XDR (headed; use xvfb-run on Linux)
```

All of these run in CI (`.github/workflows/ci.yml`) on every push to `main` and on every pull
request. If a UI change is intentional, refresh the visual baselines with
`npx playwright test --update-snapshots` and commit the updated files from
`tests/visual/popup.spec.ts-snapshots/`.

Releases are built by `.github/workflows/release.yml` on a `v*` tag. It runs the gates above and
attaches `grydlock-extension-vX.Y.Z.zip` plus `SHA256SUMS` to a
[GitHub Release](https://github.com/Gryd-lock/grydlock-extension/releases). Archives are never
committed.

**Content Security Policy.** `manifest.json` declares `content_security_policy.extension_pages`
as `script-src 'self'; object-src 'self'`. The Vite build emits no inline scripts or styles for
the popup or history pages — all scripts are bundled into separate `.js` files referenced by
`<script src="...">` tags — so both popup modes (dev and intercept) load cleanly under this CSP
with no console violations.

**Coverage policy.** Thresholds are configured in `vite.config.ts` and enforced by
`npm run test:coverage` (CI runs this instead of bare `vitest run`). The following
files are excluded from coverage because they require Chrome APIs or a real DOM
that unit tests cannot provide:

- `src/intercept/mainWorldEntry.ts` / `src/intercept/bridgeEntry.ts` — depend on `chrome.*` APIs and `postMessage` across extension worlds; covered by the e2e harness.
- `src/intercept/albedoMainWorldEntry.ts` — monkey-patches `window.open` in the MAIN world; covered by the e2e harness. Pure behavioural logic is unit-tested in `albedoMainWorldEntry.test.ts`.
- `src/background/background.ts` — service-worker `chrome.*` calls; covered by the e2e harness.
- `src/popup/main.tsx` — React entry-point boilerplate.
- `src/intercept/protocol.ts` — constant and type definitions only.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, architecture guardrails, testing
expectations, required quality gates, and the pull request checklist.

Changes that introduce or alter shared abstractions, browser-context responsibilities, message
contracts, interception semantics, or security boundaries should follow the lightweight
[Architecture Decision Record process](docs/adr/README.md).

## Roadmap

- [x] Freighter interception with a complete local transaction review.
- [x] Albedo interception (`window.open` popup flow).
- [x] Local decision history and protection-status reporting.
- [x] Remove the placeholder hash score. Scoring is off by default and the UI shows Unknown, never an invented score.
- [x] Score-source setting: Off / Testkit fixtures (testnet only) / Soroban (experimental).
- [x] End-to-end test: built extension + local dApp + testkit testnet XDR.
- [ ] A deployed Soroban risk-oracle contract to point the Soroban source at (tracked in `grydlock-oracle-adapter`).
- [ ] Asset-level checks (scam trustlines).
- [ ] xBull and Lobstr adapters.
- [ ] Firefox support.
- [ ] Localisation.

Open, scoped work is tracked as [GitHub issues](https://github.com/Gryd-lock/grydlock-extension/issues).
Issues labelled `good first issue` are self-contained.

## Dependency Maintenance

Dependabot checks npm dependencies and GitHub Actions every Monday. Updates are grouped so routine
tooling changes do not obscure runtime changes that affect the wallet-warning path.

Dependabot alerts and security updates are controlled in repository settings and should remain
enabled. This file configures the scheduled version-update pull requests.

The auto-merge policy is intentionally narrow:

- patch updates to direct development dependencies may auto-merge;
- patch updates to GitHub Actions may auto-merge;
- runtime dependencies, indirect dependencies, and every minor or major update require human review;
- a Dependabot PR with maintainer-authored changes is no longer auto-merge eligible.

Auto-merge does not replace CI. The repository must enable GitHub auto-merge, protect `main`, and
require the existing CI `verify` job. Repository or organization Actions settings must also allow
the workflow token to approve pull requests. If those settings are absent, maintainers should merge
Dependabot PRs manually after `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`
pass.
