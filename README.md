# Gryd Lock 🔒

[![CI](https://github.com/Gryd-lock/grydlock-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/Gryd-lock/grydlock-extension/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)]()
[![Built with TypeScript](https://img.shields.io/badge/Built%20with-TypeScript-3178c6?logo=typescript&logoColor=white)]()
[![Status: Early Build](https://img.shields.io/badge/status-early%20build-orange)]()

**The Gryd Lock browser extension — catches a Stellar transaction before signing and warns the user if the destination looks fraudulent.**

## Overview

This is the product. It runs entirely in the user's browser. It hooks the wallet signing flow, decodes the pending transaction, requests a risk score for the destination, and renders a four-tier warning. It never blocks — it warns, and the user decides.

> **Status:** Early build. A Freighter `signTransaction` proxy decodes the destination, routes it through the oracle adapter, and shows the warning before signing. A live oracle connection is **not yet built** — see the roadmap.

## What it does

```
User initiates a transaction in a Stellar wallet
        │
        ▼
Extension intercepts the unsigned transaction (Freighter signing flow)
        │
        ▼
Decode the transaction XDR → extract destination address / asset
        │
        ▼
Request a 0–100 risk score  (via grydlock-oracle-adapter)
        │
        ▼
Map the score to a warning tier → show the warning
        │
        ▼
User proceeds or cancels — the extension never blocks
```

### Warning tiers

| Score  | Tier     | Behaviour                                |
| ------ | -------- | ----------------------------------------- |
| 0–20   | Low      | Green indicator, proceed                  |
| 21–50  | Elevated | Soft warning                              |
| 51–75  | High     | Strong warning, require explicit confirm  |
| 76–100 | Critical | Recommend abort, explain why              |

## Why Freighter First

Stellar has no universal injected wallet provider — each wallet exposes its own signing API, so interception is per-wallet, not global. Gryd Lock targets **Freighter** first (the most widely used browser wallet), proves the interception pattern, then generalises to xBull, Albedo, and Lobstr.

## Accessibility

The warning popup is fully accessible to screen reader users (e.g., VoiceOver, NVDA). It implements the `alertdialog` ARIA role and uses an `assertive` live region to ensure the risk tier is announced immediately upon opening. The popup wires the risk level, destination, and warning message together using `aria-describedby` so the complete context is conveyed coherently without relying on visual cues.

## Tech Stack

- **TypeScript** — extension logic
- **React** — warning UI in the popup
- **Stellar SDK (JS)** — decoding the unsigned transaction
- **Manifest V3** — Chrome / Brave / Edge extension format

The risk score itself is fetched through [`grydlock-oracle-adapter`](../grydlock-oracle-adapter); this repo holds no scoring logic.

## Project Layout

```
grydlock-extension/
├── manifest.json             # MV3 — popup, background service worker, content scripts
├── scripts/
│   └── build-extension.mjs   # esbuild bundle for background.js / mainWorld.js / bridge.js
├── src/
│   ├── adapter/                # Oracle adapter stub — getScore(destination)
│   ├── background/             # Service worker: decodes XDR, scores, opens the warning popup
│   ├── decode/                  # XDR → destination extraction (Stellar SDK)
│   ├── intercept/                # Freighter signTransaction proxy + message-bridge protocol
│   ├── lib/                       # Score → tier mapping
│   └── popup/                      # React warning UI — default (dev) and intercept modes
└── README.md
```

## How the Pieces Connect

**Toolbar click (dev/testing)** — unchanged from the stub-only build:

```
manifest.json (action.default_popup)
        │
        ▼
src/popup/index.html → main.tsx → App.tsx (default mode)
                                        │
                                        ├─▶ src/adapter/oracleAdapter.ts → getScore(destination)
                                        ├─▶ src/lib/tiers.ts → tierForScore(score)
                                        └─▶ src/popup/DevScoreSlider.tsx (dev-only override)
```

**Real Freighter signing** — `@stellar/freighter-api`'s `signTransaction` doesn't call a global
function; it posts `{ source: 'FREIGHTER_EXTERNAL_MSG_REQUEST', type: 'SUBMIT_TRANSACTION', ... }`
to `window`, and Freighter's own content script replies the same way. That `postMessage` traffic is
the actual interception point:

```
dApp posts { source: FREIGHTER_EXTERNAL_MSG_REQUEST, type: SUBMIT_TRANSACTION, transactionXdr }
        │
        ▼
src/intercept/mainWorldEntry.ts   (MAIN world; grabs the request via stopImmediatePropagation()
        │                          before Freighter's own listener sees it)
        │  window.postMessage (Gryd Lock's own internal request/response, separate from Freighter's)
        ▼
src/intercept/bridgeEntry.ts      (isolated world; only place with chrome.* API access)
        │  chrome.runtime.sendMessage
        ▼
src/background/background.ts      (service worker)
        │
        ├─▶ src/decode/decodeTransaction.ts → extractDestination(xdr)
        │      no single destination? → outcome 'allow', nothing shown, request passes through
        │
        ├─▶ src/adapter/oracleAdapter.ts → getScore(destination)
        │
        └─▶ chrome.windows.create(popup?mode=intercept&requestId&destination&score)
                   │
                   ▼
             src/popup/App.tsx (intercept mode) renders the tier + destination + Proceed/Cancel
                   │  chrome.runtime.sendMessage({ type: 'DECISION_MADE', ... })
                   ▼
        background resolves the pending request → bridge → mainWorld
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
  injected into every page (`mainWorld.js` is ~2&nbsp;KB; the SDK lives in `background.js` instead).
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
- **Graceful degradation**: transactions with no single determinable destination (malformed XDR, no
  destination-bearing operation, or multiple distinct destinations) resolve to `'allow'` — Gryd Lock
  never blocks what it can't assess.
- **Destination-bearing operations**: `payment`, `pathPaymentStrictSend`/`pathPaymentStrictReceive`,
  `createAccount`, `createClaimableBalance`, and `claimClaimableBalance`. A `createClaimableBalance`
  contributes one candidate destination per claimant, since any of them may later claim it; a
  transaction with more than one claimant is a multiple-distinct-destination case and resolves to
  `'allow'` like any other batch, pending the dedicated multi-destination scoring in #20.
  `claimClaimableBalance` carries no destination account in the operation itself — only an opaque
  balance ID — so the balance ID is scored in its place.
- **Tests**: `src/decode/decodeTransaction.test.ts` and `src/intercept/resolveOutcome.test.ts` cover
  the decode/scoring/decision logic directly; `src/adapter/oracleAdapter.test.ts` and
  `src/lib/tiers.test.ts` cover the adapter stub and tier mapping; `src/popup/App.test.tsx` covers
  both the popup's default (loading/error/retry/dev-slider) and intercept-mode rendering, against a
  mocked adapter and a stubbed `chrome.runtime`, including the theme-aware tier accent variables
  used by the popup.

## Develop

1. `npm install`
2. `npm run build` (or `npm run dev` for a local dev server against the default/dev popup only —
   the content scripts and background worker require a real `chrome://extensions` load).
3. Go to `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, select the `dist/` output.
4. Open the popup from the toolbar to exercise the dev/testing flow — the score comes from the
   adapter stub, and in dev builds the dev control lets you drag through all four tiers. To exercise
   real interception, visit a page with Freighter installed and call `signTransaction`. The popup
   follows the browser or OS `prefers-color-scheme` setting in both the default preview and
   interception flows.

## Quality Gates

```bash
npm run lint           # ESLint
npm run typecheck      # tsc --noEmit
npm run test:coverage  # Vitest + v8 coverage (enforces thresholds)
npm run build          # tsc -b && vite build && node scripts/build-extension.mjs
```

All four run in CI (`.github/workflows/ci.yml`) on every push to `main` and on every pull request.

**Coverage policy.** Thresholds are configured in `vite.config.ts` and enforced by
`npm run test:coverage` (CI runs this instead of bare `vitest run`). The following
files are excluded from coverage because they require Chrome APIs or a real DOM
that unit tests cannot provide:

- `src/intercept/mainWorldEntry.ts` / `src/intercept/bridgeEntry.ts` — depend on `chrome.*` APIs and `postMessage` across extension worlds; covered by the e2e harness.
- `src/background/background.ts` — service-worker `chrome.*` calls; covered by the e2e harness.
- `src/popup/main.tsx` — React entry-point boilerplate.
- `src/intercept/protocol.ts` — constant and type definitions only.

## Roadmap

- [x] Popup renders one score across the four tiers. _(stub)_
- [x] Fetch the score through the oracle adapter (stub score) — prove the query path end to end.
- [x] Freighter interception: proxy `signTransaction`, decode the XDR, extract the destination, route it through the adapter.
- [ ] Swap the stub score for a live one from the adapter.
- [ ] Generalise interception beyond Freighter.

> **Do not build real interception until the adapter returns a real score.** Interception without a working score source is a warning with nothing to warn about.
