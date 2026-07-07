# Gryd Lock 🔒

[![CI](https://github.com/Gryd-lock/grydlock-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/Gryd-lock/grydlock-extension/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)]()
[![Built with TypeScript](https://img.shields.io/badge/Built%20with-TypeScript-3178c6?logo=typescript&logoColor=white)]()
[![Status: Early Build](https://img.shields.io/badge/status-early%20build-orange)]()

**The Gryd Lock browser extension — catches a Stellar transaction before signing and warns the user if the destination looks fraudulent.**

## Overview

This is the product. It runs entirely in the user's browser. It hooks the wallet signing flow, decodes the pending transaction, requests a risk score for the destination, and renders a four-tier warning. It never blocks — it warns, and the user decides.

> **Status:** Early build. The popup renders a live stub score across four tiers. Real signing interception and a live score connection are **not yet built** — see the roadmap.

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

## Tech Stack

- **TypeScript** — extension logic
- **React** — warning UI in the popup
- **Stellar SDK (JS)** — decoding the unsigned transaction
- **Manifest V3** — Chrome / Brave / Edge extension format

The risk score itself is fetched through [`grydlock-oracle-adapter`](../grydlock-oracle-adapter); this repo holds no scoring logic.

## Project Layout

```
grydlock-extension/
├── manifest.json          # MV3, popup only
├── src/
│   ├── adapter/            # Oracle adapter stub — getScore(destination)
│   ├── lib/                # Score → tier mapping
│   └── popup/              # React warning UI (App, dev slider, HTML/entry)
│       ├── intercept/      # Freighter signing proxy  (phase 2, not yet built)
│       └── decode/         # XDR → destination extraction  (phase 2, not yet built)
└── README.md
```

## How the Pieces Connect

```
manifest.json (action.default_popup)
        │
        ▼
src/popup/index.html
        │
        ▼
src/popup/main.tsx  ── mounts ──▶  src/popup/App.tsx
                                        │
                                        ├─▶ src/adapter/oracleAdapter.ts
                                        │     getScore(destination) → Promise<number>
                                        │     (stub standing in for the real
                                        │      grydlock-oracle-adapter package)
                                        │
                                        ├─▶ src/lib/tiers.ts
                                        │     tierForScore(score) → { tier, label, colour, message }
                                        │
                                        └─▶ src/popup/DevScoreSlider.tsx
                                              (dev-only, gated on import.meta.env.DEV;
                                               overrides the displayed score so all four
                                               tiers can be exercised without the adapter)
```

- **Entry point**: `manifest.json` points Chrome at `src/popup/index.html` as the popup.
- **Bootstrap**: `index.html` loads `main.tsx`, which mounts `App.tsx` into `#root`.
- **Scoring**: on mount, `App.tsx` calls `getScore()` from `src/adapter/oracleAdapter.ts` for a
  placeholder destination. This is the only source of the displayed score — nothing is hardcoded
  in the popup.
- **Tiering**: the resolved score is passed through `tierForScore()` in `src/lib/tiers.ts`, which
  maps it to one of the four tiers above with a label, colour, and message.
- **Dev testing**: in dev builds, `DevScoreSlider.tsx` renders below the tier UI and lets a
  developer override the displayed score locally, so all four tiers are reachable without waiting
  on real adapter data.
- **Build**: `vite.config.ts` builds `src/popup/index.html` as the only entry and copies
  `manifest.json` into `dist/`, so the built `dist/manifest.json`'s `default_popup` path matches
  the built output layout (`dist/src/popup/index.html`).
- **Tests**: `src/adapter/oracleAdapter.test.ts` and `src/lib/tiers.test.ts` cover the scoring and
  tiering logic; `src/popup/App.test.tsx` covers the popup's loading/error/retry states and the
  dev-slider override, rendered with `@testing-library/react` against a mocked adapter.

## Develop

1. `npm install`
2. `npm run build` (or `npm run dev` for a local dev server).
3. Go to `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, select the `dist/` output.
4. Open the popup. The score comes from the adapter stub; in dev builds, drag the dev control to see all four tiers.

## Quality Gates

```bash
npm run lint       # ESLint
npm run typecheck  # tsc --noEmit
npm test           # Vitest
npm run build      # tsc -b && vite build
```

All four run in CI (`.github/workflows/ci.yml`) on every push to `main` and on every pull request.

## Roadmap

- [x] Popup renders one score across the four tiers. _(stub)_
- [x] Fetch the score through the oracle adapter (stub score) — prove the query path end to end.
- [ ] Freighter interception: proxy `signTransaction`, decode the XDR, extract the destination, route it through the adapter.
- [ ] Swap the stub score for a live one from the adapter.
- [ ] Generalise interception beyond Freighter.

> **Do not build real interception until the adapter returns a real score.** Interception without a working score source is a warning with nothing to warn about.
