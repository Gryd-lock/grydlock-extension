# Architecture

How Gryd Lock intercepts a signing request, reviews it and returns a decision. The README has the short version; this page has the detail.

### What it does

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

#### Warning tiers

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

### Why Freighter First

Stellar has no universal injected wallet provider — each wallet exposes its own signing API, so interception is per-wallet, not global. Gryd Lock targets **Freighter** first (the most widely used browser wallet), proves the interception pattern, then generalises to xBull, Albedo, and Lobstr.

### Albedo Interception

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

### Accessibility

The warning is a modal `role="dialog"` labelled by its tier heading, which sits in an
`aria-live="assertive"` region so screen readers (VoiceOver, NVDA) announce the tier on open. Each
tier also has a distinct icon, so colour is never the only signal, and review findings are
rendered in a `role="alert"` list. Keyboard behaviour is described under
[How the Pieces Connect](#how-the-pieces-connect). `jest-axe` checks run in the popup tests.

### Decision History

Proceed/cancel decisions on **scored** destinations are recorded locally: destination, asset
(when present), score, tier, decision, and timestamp. Reviews without a score (for example, with
scoring off) are not recorded yet. Open it via the extension's
**Options** page (right-click the toolbar icon → Options, or `chrome://extensions` → Gryd Lock →
Details → Extension options).

Privacy:

- History lives only in `chrome.storage.local` on your device — it is never transmitted anywhere.
- Storage is capped to the most recent 200 decisions; older entries are dropped automatically.
- A **Clear history** button on the page deletes everything at once.

### Protection coverage

The toolbar popup reports a fresh, per-tab health status instead of a placeholder score. A
`protected` result requires a recent MAIN-world → isolated bridge → worker → MAIN-world handshake;
the handshake carries only an ephemeral nonce, adapter name, and protocol version. It never signs,
submits, reads, or exposes a transaction. The popup distinguishes stale, bridge unavailable,
worker unavailable, permission denied, adapter incompatible, unsupported, and unknown states.

This proves Gryd Lock's own execution contexts can communicate, but it cannot prove Chrome will
order it before another extension's listener. That browser limitation remains visible in the UI and
is a real-wallet release gate. Supported adapters and explicit exclusions are in
[protection coverage](protection-coverage.md).

### Transaction review coverage

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

### How the Pieces Connect

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
