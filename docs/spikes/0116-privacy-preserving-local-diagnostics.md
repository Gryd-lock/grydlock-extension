# Spike 0116: Privacy-preserving local diagnostics and health reporting

- **Status:** Complete — recommendation ready for maintainer decision
- **Issue:** #116
- **Date:** 2026-08-17
- **Applies to:** extension version `0.1.0` and current `main`
- **Prototype:** [`src/diagnostics/diagnostics.ts`](../../src/diagnostics/diagnostics.ts), [`src/diagnostics/diagnostics.test.ts`](../../src/diagnostics/diagnostics.test.ts)

## Question

How can failures and interception health be diagnosed without violating the no-telemetry privacy model?

## Summary of the recommendation

Adopt a **local-only, counter-based diagnostics model with no automatic transmission of any kind**:

1. Record **aggregate event counters** keyed by a closed set of code-path names, bucketed by hour, in `chrome.storage.local`.
2. Derive a **runtime health view** from those counters plus five active self-checks, and show it in the existing options page.
3. Allow the user to **export a report file** through an explicit click. Export is the only path by which diagnostics leave the device, it is always user-initiated, and the exported file is generated from the same guarded builder as the on-screen view.
4. Do **not** build an opt-in upload channel, remote endpoint, or "share with maintainers" button in this phase. A user pasting an exported file into a GitHub issue is the transport, and it costs the project nothing in attack surface, consent UX, or store-review risk.

This keeps the current PRIVACY.md claim ("no telemetry") literally true while giving maintainers something to ask for in a bug report: _"open Options, click Export diagnostics, attach the JSON."_

The prototype in `src/diagnostics/` implements the schema, the retention arithmetic, and the redaction guard as pure functions. It is not imported by the shipped extension; wiring is bounded follow-up work described at the end of this document.

## Context and problem

Gryd Lock sits in a wallet signing path across four execution contexts, and a failure in any of them looks identical to the user: no warning appears. Today the only diagnosis available is a synthetic test suite and manual reproduction, so a maintainer receiving "the extension did nothing" cannot distinguish:

| Failure class   | Example                                                                                                                                                                    | Current visibility |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Injection       | MAIN-world script never ran on the page, or the manifest match failed                                                                                                      | None               |
| Ordering        | Freighter's content script registered its listener first, so the request was never seen ([`mainWorldEntry.ts`](../../src/intercept/mainWorldEntry.ts) documents this race) | None               |
| Wallet protocol | dApp used a message shape the interceptor does not recognize                                                                                                               | None               |
| Decoding        | XDR parsed but yielded no supported destination, so the flow degraded to `allow`                                                                                           | None               |
| Oracle          | timeout or open circuit breaker returned `-1` ([`oracleAdapter.ts`](../../src/adapter/oracleAdapter.ts))                                                                   | Console only       |
| Popup lifecycle | review window was closed or the MV3 worker was terminated mid-decision                                                                                                     | None               |
| Browser         | permission revoked, service worker not starting                                                                                                                            | None               |

Each of these is distinguishable by _counter shape alone_, without knowing anything about the transaction. That observation is the basis of the whole recommendation: interception health is a control-flow question, not a data question.

## Threat and privacy analysis

### What an adversary would want from a diagnostics feature

| Adversary                                   | Capability                                                                       | What diagnostics could leak                                                                   | Mitigation in this design                                                                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malicious or curious dApp/page script       | Runs in the same page and MAIN world                                             | Whether the user is protected, transaction values, timing correlation with a specific request | Diagnostics live in the background worker and extension pages only. No counter, report, or health value is ever posted to `window` or exposed to page scripts. |
| Another installed extension                 | May read shared surfaces, cannot read another extension's `chrome.storage.local` | Stored counters                                                                               | Counters carry no addresses; worst case an attacker learns aggregate usage volume it can already infer by observing the page.                                  |
| Local malware / profile theft               | Full read of the extension's storage                                             | Everything persisted                                                                          | Persisted data is bounded to counters plus hour buckets, so the incremental disclosure over the already-stored decision history is close to zero.              |
| Maintainer receiving a support bundle       | Reads whatever the user pastes                                                   | Destinations, XDR, dApp origins, timing                                                       | Prohibited fields never exist in the report; the builder fails closed if they somehow appear.                                                                  |
| Network observer / oracle operator          | Sees requests from the adapter                                                   | Correlation of diagnostics with destination queries                                           | No diagnostics transport exists, so there is nothing to correlate.                                                                                             |
| Attacker who can write to extension storage | Compromised profile                                                              | Injects attacker-controlled strings that a maintainer later opens                             | `parseState` discards unknown keys and non-numeric counts; the report builder re-scans and refuses to build.                                                   |

### Fingerprinting and re-identification

A diagnostics export is a file the user hands to someone. Three properties keep it from becoming an identifier:

- **Coarse time.** All timestamps are floored to the hour, so a bucket cannot be aligned with an individual signing request or with a block explorer entry.
- **Coarse environment.** Browser family and _major_ version only, plus a four-value platform enum. No full user-agent, no locale, no timezone, no screen metrics, no extension install ID.
- **Stable shape.** `totals` always contains every known event including zeroes, so the presence or absence of a key never reveals which features a specific user exercised.

The residual signal is the counter values themselves. Aggregate activity volume over a 7-day window is weakly identifying at best and is inherent to any usefulness at all; it is accepted and documented rather than mitigated further.

### Interaction with the existing privacy posture

Two findings worth recording separately from this spike:

1. **PRIVACY.md is out of date.** Section 3 states that Gryd Lock "does not write or persist any data", but [`src/lib/history.ts`](../../src/lib/history.ts) persists destination, asset, score, tier, decision, and a millisecond timestamp under `decisionHistory`, and [`src/utils/storageHelper.ts`](../../src/utils/storageHelper.ts) persists a trusted-address allowlist. Diagnostics must not be added on top of a stale policy document; the policy should be corrected in the implementation PR that lands counters.
2. **The existing decision history is strictly more sensitive than anything proposed here.** It already contains destinations and exact timestamps. Diagnostics must therefore be a _separate_ storage key with its own retention and its own clear control — never folded into the history record, and never exported together with it by default.

## Data field classification

The classification below is the normative answer to the first acceptance criterion. "Default" means what a diagnostics export contains with no further user action.

### Safe — collected by default

Aggregate, non-reversible, describes code paths rather than values.

| Field                                                             | Rationale                                                                                 |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Event counters from the closed `DIAGNOSTIC_EVENTS` set            | Names a branch in Gryd Lock's own code; cannot be derived from transaction content.       |
| Hour bucket boundary (`hourStart`)                                | Coarse enough that it cannot single out one signing request.                              |
| Report `schemaVersion`, `generatedAt`, `windowStart`, `windowEnd` | Structural.                                                                               |
| Extension version (semver from the manifest)                      | Needed to map a report to a build.                                                        |
| Browser family and major version                                  | Needed to separate Chromium and Firefox behavior; deliberately not the user-agent string. |
| Platform enum (`windows` / `macos` / `linux` / `other`)           | Needed for OS-specific window and lifecycle bugs.                                         |
| Health-check statuses (`ok` / `degraded` / `failed` / `unknown`)  | Derived booleans about Gryd Lock's own runtime.                                           |

### Sensitive — excluded by default, only ever with explicit per-export consent

Useful for deep debugging, but re-identifying or behavior-revealing. None of these are implemented by the prototype; they are listed so a future "detailed bundle" checkbox has a pre-agreed boundary.

| Field                                            | Why sensitive                                             | Condition if ever added                                                                                         |
| ------------------------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Page origin where interception ran               | Browsing history                                          | Only with a separate, unchecked-by-default consent toggle, and never the full URL — registrable domain at most. |
| Exact event timestamps (ms)                      | Correlates with on-chain activity                         | Same toggle; strongly discouraged.                                                                              |
| Wallet identity and version (Freighter / Albedo) | Narrows the user population                               | Acceptable only when the user is filing a wallet-specific bug.                                                  |
| Error `name` from a caught exception             | May embed a message with data                             | Allowlisted error classes only, never `error.message` or a stack.                                               |
| Locale, timezone, screen metrics                 | Classic fingerprinting vector                             | Not to be collected.                                                                                            |
| Score and tier distribution                      | Reveals what kind of destinations the user transacts with | Not to be collected.                                                                                            |

### Prohibited — must never be recorded, persisted, displayed in diagnostics, or exported

| Field                                                        | Reason                                                            |
| ------------------------------------------------------------ | ----------------------------------------------------------------- |
| Transaction XDR, signed or unsigned                          | Contains destination, amount, memo, sequence, source account      |
| Destination, source, or muxed account addresses (`G…`, `M…`) | Directly identifying, links to chain activity                     |
| Contract IDs (`C…`) and invoked function names               | Identifies the dApp interaction                                   |
| Private keys, seed phrases, secret strkeys (`S…`)            | Gryd Lock never holds these and must never appear to ask for them |
| Amounts, assets, asset issuers, memos                        | Financial content                                                 |
| Request identifiers (`requestId`, Freighter `messageId`)     | Joins a report to a specific signing event                        |
| Full URLs, page titles, referrers                            | Browsing history                                                  |
| Raw error messages and stack traces from wallet or page code | Unbounded, may embed any of the above                             |
| Any network transmission of diagnostics                      | Breaks the no-telemetry model                                     |

The prototype enforces the prohibited list twice: by construction (no field in the schema can hold a value-bearing string) and by a `findProhibitedContent` scan over the serialized report that matches strkeys, XDR-shaped base64, URLs, and email addresses. A match makes `buildReport` throw rather than return a report — failing to produce diagnostics is always preferable to leaking them.

## Proposed schema

Types are defined in [`src/diagnostics/diagnostics.ts`](../../src/diagnostics/diagnostics.ts).

### Persisted state

```ts
interface DiagnosticsState {
  schemaVersion: number
  buckets: Array<{
    hourStart: number // Unix ms, floored to the hour
    counts: Partial<Record<DiagnosticEvent, number>>
  }>
}
```

Stored under a dedicated key (`diagnosticsCounters`), separate from `decisionHistory` and `trustedAddresses`.

### Event vocabulary

Nineteen events across five families, chosen so that each failure class in the table above is distinguishable:

| Family                   | Events                                                                             | Diagnostic value                                                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intercept.*`            | `request.observed`, `request.replayed`, `request.cancelled`, `listener.registered` | `listener.registered` present but `request.observed` at zero, on a user who says they signed a transaction, is the ordering race or an unrecognized wallet protocol. |
| `decode.*`               | `success`, `unsupported`, `failure`                                                | Separates "we saw the request but could not model it" from a parser defect.                                                                                          |
| `score.*`                | `fresh`, `cache_hit`, `timeout`, `breaker_open`, `failure`                         | Oracle availability, distinct from decode and interception.                                                                                                          |
| `popup.*`                | `opened`, `decision.proceed`, `decision.cancel`, `closed_without_decision`         | `opened` far above the sum of the decisions indicates a popup-lifecycle or MV3-termination bug.                                                                      |
| `runtime.*`, `storage.*` | `message_dropped`, `worker_start`, `write_failure`                                 | Service-worker churn and storage failures.                                                                                                                           |

Adding an event is a privacy-review change, because the closed set is what makes "no free-form strings" enforceable.

### Report

```ts
interface DiagnosticsReport {
  schemaVersion: number
  generatedAt: number // hour-floored
  windowStart: number | null // oldest retained bucket
  windowEnd: number | null // newest retained bucket
  environment: {
    extensionVersion: string // semver-validated
    browser: 'chromium' | 'firefox' | 'other'
    browserMajorVersion: number | null
    platform: 'windows' | 'macos' | 'linux' | 'other'
  }
  health: Record<'interception' | 'bridge' | 'background' | 'oracle' | 'storage', HealthStatus>
  totals: Record<DiagnosticEvent, number> // all events, zeroes included
  buckets: DiagnosticsBucket[]
}
```

### Runtime health checks

The five health entries are cheap, local, and answer "is Gryd Lock actually working right now":

| Check          | Method                                                                                         | `degraded` / `failed` means                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `interception` | Background asks the active tab's bridge whether the MAIN-world interceptor announced itself    | Scripts did not inject, or host access was revoked (a real scenario on Firefox MV3, see spike 0117) |
| `bridge`       | Round-trip `chrome.runtime` ping to the isolated-world content script                          | Content script missing or messaging broken                                                          |
| `background`   | Worker records `runtime.worker_start` and answers the ping                                     | Service-worker startup failures                                                                     |
| `oracle`       | Reads circuit-breaker state and last outcome from the adapter, without issuing a probe request | Scoring is failing open, so users are seeing `Unknown` tiers                                        |
| `storage`      | Write-read-delete of a sentinel key                                                            | Quota or profile corruption, which would also silently break the trusted-address allowlist          |

The checks are read-only with respect to user data and introduce no new permission.

## Sample redacted report

Generated by the prototype from a synthetic two-hour session. This is the complete file a user would attach to an issue — there is nothing omitted from it.

```json
{
  "schemaVersion": 1,
  "generatedAt": 1786701600000,
  "windowStart": 1786698000000,
  "windowEnd": 1786701600000,
  "environment": {
    "extensionVersion": "0.1.0",
    "browser": "chromium",
    "browserMajorVersion": 138,
    "platform": "linux"
  },
  "health": {
    "interception": "ok",
    "bridge": "ok",
    "background": "ok",
    "oracle": "degraded",
    "storage": "ok"
  },
  "totals": {
    "intercept.request.observed": 5,
    "intercept.request.replayed": 1,
    "intercept.request.cancelled": 1,
    "intercept.listener.registered": 1,
    "decode.success": 4,
    "decode.unsupported": 1,
    "decode.failure": 0,
    "score.fresh": 2,
    "score.cache_hit": 1,
    "score.timeout": 1,
    "score.breaker_open": 1,
    "score.failure": 1,
    "popup.opened": 3,
    "popup.decision.proceed": 1,
    "popup.decision.cancel": 1,
    "popup.closed_without_decision": 1,
    "runtime.message_dropped": 1,
    "runtime.worker_start": 2,
    "storage.write_failure": 0
  },
  "buckets": [
    {
      "hourStart": 1786698000000,
      "counts": {
        "runtime.worker_start": 1,
        "intercept.listener.registered": 1,
        "intercept.request.observed": 4,
        "decode.success": 3,
        "decode.unsupported": 1,
        "score.fresh": 2,
        "score.cache_hit": 1,
        "score.timeout": 1,
        "popup.opened": 3,
        "popup.decision.proceed": 1,
        "popup.decision.cancel": 1,
        "popup.closed_without_decision": 1,
        "intercept.request.replayed": 1,
        "intercept.request.cancelled": 1
      }
    },
    {
      "hourStart": 1786701600000,
      "counts": {
        "runtime.worker_start": 1,
        "intercept.request.observed": 1,
        "decode.success": 1,
        "score.breaker_open": 1,
        "score.failure": 1,
        "runtime.message_dropped": 1
      }
    }
  ]
}
```

A maintainer reads this as: interception and decoding are healthy, one transaction shape was unsupported, the oracle degraded in the second hour (timeout, then an open breaker and a failure), and one review popup was closed without a decision. That is enough to route the bug — with no idea who the user is, where they browsed, or what they signed.

## Local-only diagnostic flow

```
background worker                     options page (extension origin)
─────────────────                     ──────────────────────────────
recordEvent(state, event, Date.now())
  └─ debounced write to
     chrome.storage.local             "Diagnostics" section
     key: diagnosticsCounters    ───▶ parseState(stored, now)
                                      buildReport({state, now, environment, health})
                                        ├─ validate environment + health
                                        ├─ prune to retention window
                                        └─ redaction guard, throw on match
                                      ├─ render health + counters on screen
                                      ├─ [Export report] → Blob download, user-initiated
                                      └─ [Clear diagnostics] → remove storage key
```

Properties of the flow:

- Counters are written only by the background worker, and only from Gryd Lock's own code paths. No message from the page or bridge can name an event.
- The options page reads through `parseState`, so tampered storage cannot inject content into the rendered view.
- Nothing is transmitted. Export writes a file via a `Blob` and an object URL, using the existing `storage` permission and no new host or `downloads` permission.
- The same builder produces the on-screen view and the exported file, so what the user sees is exactly what they would share. No hidden fields.

## Retention and consent

**Retention.**

- Rolling window of 7 days (`MAX_BUCKETS = 168` hourly buckets), enforced on every write _and_ every read, so a profile that stops recording still ages out.
- Bounded storage: 168 buckets x at most 19 integer counters serializes to roughly 110 KB in the pathological case where every counter fires in every hour of a week. A realistic profile stores a handful of buckets with a few counters each, so the working size is single-digit KB. Both are negligible against the `chrome.storage.local` quota, and the bound is hard rather than best-effort because pruning runs on read as well as write.
- Clearing is immediate and total: removing the storage key is the whole operation, since counters have no derived copies.
- Uninstalling the extension removes the data with the profile's extension storage.

**Consent.**

| Action                     | Consent model                                                                   | Rationale                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Recording counters locally | On by default, with a visible toggle to disable                                 | Counters never leave the device and contain no user content, so a consent prompt would be noise; the toggle keeps it honest. |
| Viewing the health panel   | No consent needed                                                               | Reading one's own device state.                                                                                              |
| Exporting a report file    | Explicit per-export user action                                                 | Export is the only egress; it must be a deliberate click, never automatic, never on a timer.                                 |
| Transmitting anywhere      | Not implemented, and out of scope                                               | Preserves the no-telemetry claim.                                                                                            |
| Adding any sensitive field | Separate, unchecked-by-default toggle plus a written statement of what is added | Prevents scope creep from quietly widening the export.                                                                       |

Disabling recording clears existing counters in the same action, so "off" means "no diagnostics data on this device".

## Options considered

| Option                                                         | Privacy                                                                                             | Usefulness                                                                                 | UX                                                              | Storage                               | Complexity                                                                                     | Attack surface                                                | Verdict                                |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------- |
| Do nothing (console logs only)                                 | Best                                                                                                | Very low — requires the user to open DevTools and read raw logs that may echo request data | Poor                                                            | None                                  | None                                                                                           | None                                                          | Rejected: does not answer the question |
| **Local counters + health view + manual export (recommended)** | Strong: no egress, no values, guarded                                                               | High: distinguishes all seven failure classes                                              | One panel in the existing options page                          | Hard-bounded, single-digit KB typical | Moderate                                                                                       | Storage key plus one export path                              | **Recommended**                        |
| Local counters plus opt-in upload to a maintainer endpoint     | Weakens the no-telemetry claim; adds IP-address exposure and timing correlation with oracle queries | Marginally higher (no user copy-paste)                                                     | Requires a consent dialog that must be honest about IP exposure | Same                                  | High: endpoint, auth, abuse handling, retention policy on the server, store-listing disclosure | New network egress and a new server to defend                 | Rejected for this phase                |
| Full local event log with timestamps and origins               | Poor: becomes a browsing and signing history                                                        | Highest for deep debugging                                                                 | Requires strong warnings before sharing                         | Large and unbounded                   | High                                                                                           | A high-value file users are asked to paste into public issues | Rejected                               |
| Remote-toggled "debug mode"                                    | Poor: remote control of client behavior                                                             | Moderate                                                                                   | Invisible to the user                                           | Small                                 | High                                                                                           | Remote command channel into the extension                     | Rejected outright                      |

## Recommendation

Adopt the local counters plus health view plus manual export model, with the field classification, retention, and consent rules above as binding constraints. Do not build a transmission channel. Revisit only if maintainers can demonstrate that exported bundles from real users are insufficient to triage a class of production failure — and even then, reconsider only after the oracle transport itself has a documented privacy design.

Because this creates a long-lived constraint on what may be recorded and exported, the implementation PR should carry an ADR (`docs/adr/`) capturing the classification and the no-transmission rule, so a future contributor cannot widen the schema without superseding a recorded decision.

## Bounded follow-up implementation

Five issues, each independently reviewable. Estimates assume the prototype lands as-is.

1. **Persistence layer** (S) — `diagnosticsCounters` storage key, debounced writes, load-through-`parseState`, recording toggle plus clear action. Depends on nothing.
2. **Instrument the pipeline** (M) — emit the 19 events from [`background.ts`](../../src/background/background.ts), [`resolveOutcome.ts`](../../src/intercept/resolveOutcome.ts), [`oracleAdapter.ts`](../../src/adapter/oracleAdapter.ts), and the bridge. Must not change any signing-path behavior or add latency to the review flow; counters are fire-and-forget and failures to record are swallowed.
3. **Health checks** (M) — the five probes, including the bridge ping and the adapter's breaker state.
4. **Diagnostics UI and export** (M) — a section in the existing options page rendering health and counters, with export and clear buttons.
5. **Policy and ADR** (S) — correct the stale PRIVACY.md persistence section, document diagnostics, and record the ADR.

Out of scope, explicitly: any upload channel, any per-request logging, any sensitive-tier field, and any change to what the decision history stores.

## Acceptance criteria

- [x] Data fields are classified as safe, sensitive, or prohibited — three tables above, with the prohibited list enforced in code.
- [x] A local-only diagnostic flow is prototyped and specified — flow diagram above; pure prototype in `src/diagnostics/` with 24 unit tests.
- [x] XDR, private keys, and destinations are excluded by default — excluded by construction and re-checked by the redaction guard, which fails the build of a report rather than emitting one.
- [x] Retention and consent behavior are defined — 7-day rolling window enforced on read and write; consent table above; export is always user-initiated.
- [x] Follow-up implementation is bounded — five sized issues with explicit out-of-scope items.

## Revisit criteria

- A live oracle replaces the stub, adding real network failure modes and its own privacy design.
- Firefox support lands, making revoked host permissions a routine cause of silent inactivity (see spike 0117).
- Exported bundles repeatedly fail to explain a reported production failure.
- Any proposal to transmit diagnostics, which requires superseding the ADR rather than extending this spike.
