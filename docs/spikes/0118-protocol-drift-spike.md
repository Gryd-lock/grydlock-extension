# Spike: Detecting Protocol Drift Across Real Freighter and Albedo Releases

**Category:** Spike
**Status:** Proposal + working PoC
**Owner:** (fill in)
**Related code:** `e2e/freighter-interception.spec.ts`, `e2e/signTransaction.spec.ts`

---

## 1. Problem Statement

Gryd Lock's e2e suite injects a hand-written message that *looks like* a Freighter
`SUBMIT_TRANSACTION` request. That message is a fixture Gryd Lock's own engineers wrote,
based on Gryd Lock's own understanding of the protocol. It will stay green forever, even
after:

- Freighter renames a field (`transactionXdr` → `xdr`, seen historically in other wallet
  APIs going through v1→v2 migrations)
- Freighter changes `source` or `type` string constants
- Freighter or Albedo changes *when* their content script registers relative to page load
  (`document_start` vs `document_idle`, or a delayed `MAIN`-world bootstrap)
- A new Freighter release changes popup behavior (e.g. moves from `action` popup to a
  dedicated tab, or adds a Blockaid pre-screen step before the signing UI)
- Albedo changes its pop-up-window intent contract, or ships an "implicit flow" session
  token whose shape Gryd Lock has never tested against
- A response contract changes shape (e.g. Freighter's response envelope adding a `status`
  field, so Gryd Lock's own downstream code silently mis-parses a real reply)

**None of this is caught by CI today**, because CI only ever talks to the fixture, never
to a real installed wallet binary. This is the core blind spot this spike addresses.

---

## 2. Current Synthetic Coverage — What It Actually Proves

| Layer | What the synthetic test proves | What it does NOT prove |
|---|---|---|
| `window.postMessage({source:'FREIGHTER_EXTERNAL_MSG_REQUEST', ...})` | Gryd Lock's own content script reacts correctly to a message shaped exactly like Gryd Lock expects | That real Freighter ever sends a message shaped like this, in this version, in this order |
| `context.waitForEvent('page', p => p.url().includes('popup.html'))` | Gryd Lock's *own* popup opens when its *own* handler fires | Nothing about Freighter or Albedo's popup behavior |
| Fixture XDR string | Gryd Lock parses a valid-looking XDR | Nothing about wallet-specific XDR quirks (Soroban auth entries, fee-bump wrapping) |

**Conclusion:** synthetic coverage is a valid *unit-level* test of Gryd Lock's interception
logic in isolation. It is not, and cannot be, a substitute for protocol-conformance
testing against the real wallets. Both are needed; they test different failure modes.

---

## 3. Real-Wallet Testing Options — Comparison

| Option | Detection value | Reliability | Ops cost | Reproducibility | Notes |
|---|---|---|---|---|---|
| **A. Pull latest Freighter/Albedo release into e2e, unpacked, on every CI run** | High (catches drift immediately) | Low — flaky on the wallet's own bugs/network calls unrelated to Gryd Lock | Low (one download step) | Poor — "latest" is a moving target, red CI doesn't tell you whose fault it is | Good for a scheduled canary, bad for PR-blocking CI |
| **B. Pin a specific Freighter/Albedo version, vendor it, bump deliberately** | High, plus attributable (you know exactly which version you tested) | High | Medium (someone has to bump the pin and review the diff) | Excellent | **Recommended default** |
| **C. Contract/protocol tests only (schema validation of captured real messages, no full extension boot)** | Medium — catches shape drift, not popup/UX drift | High | Low | Excellent | Cheap, fast, good PR-gate companion to B |
| **D. Manual exploratory pass on each new Freighter/Albedo release (changelog-triggered)** | High for UX/timing/popup-behavior drift that automation is bad at | Depends on tester | Medium (recurring human time) | Low | Necessary safety net — automation won't catch every popup redesign |
| **E. Fully manual production monitoring / user bug reports** | Low value as *detection*, high value as *confirmation* | N/A | Near zero | N/A | Last resort, not a strategy |

**Recommendation:** run **B + C in CI on every PR**, run **A as a nightly/weekly scheduled
canary** (non-blocking, files an issue on failure), and run **D whenever the changelog for
either wallet shows a signing-flow or messaging change** (see §7).

---

## 4. Wallet Compatibility Matrix

This matrix is the artifact that should live in the repo (`docs/wallet-compatibility.md`)
and get a row added every time a wallet version is verified — automated or manual.

| Wallet | Version tested | Injection mechanism | Registration timing | Message `source`/type constants | Popup mechanism | Response contract | Verified by | Date |
|---|---|---|---|---|---|---|---|---|
| Freighter | e.g. 5.x (pin exact) | `MAIN`-world content script + relay | `document_start`, but async `postMessage` after wallet unlock check | `FREIGHTER_EXTERNAL_MSG_REQUEST` / `SUBMIT_TRANSACTION` (confirm against current release, do not assume) | `chrome.windows.create` dedicated signing window (not a toolbar `action` popup) | Signed XDR + optional Blockaid scan result envelope | automated (B) | — |
| Albedo | e.g. 0.x (pin exact) | Page redirect / `albedo-intent` opens `window.open` pop-up to `albedo.link`, not a `chrome.windows.create` from an extension background page | Pop-up only opens on explicit `albedo.<intent>()` call — no ambient content-script injection to race against | Uses `postMessage` handshake between opener and popup, not a documented "external msg" constant like Freighter's | Browser popup **window** (real page, not a MV3 action popup) → reachable via `context.waitForEvent('page', ...)` | Signed XDR, or session token for implicit flow | manual only so far | — |
| Freighter (mobile / WalletConnect) | n/a | Out of scope for browser-extension e2e | — | — | — | — | — | — |

**Fill-in obligation:** every cell above marked "confirm against current release" must be
verified against the actual installed extension before being trusted — do not hardcode
these from documentation alone, since docs and shipped code drift from each other too.
The PoC in §8 captures the real values programmatically so this table can be generated,
not hand-maintained.

**Key structural difference the matrix surfaces:** Freighter's warning must be caught via
message interception *before* a window opens (Gryd Lock's actual use case), while Albedo's
flow is fundamentally popup-first with no ambient page-level message to intercept at all —
meaning Gryd Lock's protection model for Albedo is architecturally different (and weaker,
by design) from its Freighter model. That asymmetry itself is worth a README callout and
a dedicated test, not just a fixture.

---

## 5. Protocol-Fixture / Contract-Test Proposal

Goal: stop trusting hand-written fixtures. Instead:

1. **Define a versioned schema** (Zod, in `tests/fixtures/protocol-contracts/`) for every
   message shape Gryd Lock depends on: Freighter's `SUBMIT_TRANSACTION` request/response,
   Albedo's intent postMessage handshake, and any SEP-0007 `web+stellar:` link handling.
2. **Two validation paths against the same schema:**
   - *Synthetic path* (current CI): the hand-written fixture must validate against the
     schema. This just guarantees internal consistency — no new information, but cheap.
   - *Captured-real path* (the actual drift detector): during the scheduled real-extension
     run (§3, Option A/B), record every message the real wallet actually sends/receives
     and validate *that* against the same schema. **A schema failure here is the drift
     signal** — it means the real wallet no longer matches what Gryd Lock's code assumes,
     independent of whether Gryd Lock's interception logic happens to still "work" by luck.
3. **Version the schema per wallet-version pin.** When a new wallet version is
   deliberately adopted (§3B), the schema is updated in the same PR as the version bump,
   with an explicit diff reviewable by a human — this is the audit trail for "what changed
   and did we account for it."
4. **Golden captures.** Store one real captured message payload per wallet version
   (redacted of any real key material) as a fixture snapshot. CI diffs new captures against
   the last golden snapshot and fails loudly (not silently falls back to schema-only) on
   any structural change, even one the schema is loose enough to still accept.

See `poc/protocol-contract.schema.ts` for a working schema + validator.

---

## 6. Injection-Order Detection

The README already flags registration-order dependence. To make this observable rather
than folklore:

- **Instrument, don't assume.** Add a debug-only counter in Gryd Lock's `MAIN`-world
  script that timestamps when it attaches its `message` listener, and expose it on
  `window.__grydlockDebug.listenerAttachedAt`. Real Freighter has no equivalent hook, so
  the PoC instead measures *effective* order: fire a canary message the instant the page
  loads and see which extension's listener log (via `console.log`, captured by Playwright's
  `page.on('console', ...)`) fires first.
- **Run the same test 20–30 times per CI trigger for order-sensitive scenarios** (not
  every run — this is expensive) and assert a distribution, not a single boolean. Flaky
  ordering is itself the finding; report the failure rate, don't just retry until green.
- **Test both extension load orders explicitly**: `--load-extension=grydlock,freighter`
  and `--load-extension=freighter,grydlock`. Chrome does not guarantee content-script
  execution order matches `--load-extension` argument order, so both must be exercised
  rather than assumed equivalent.

---

## 7. Browser Startup & Extension Installation Strategy

- **Do not use the Chrome Web Store at test time.** It's non-reproducible (auto-updates),
  rate-limited for scripted installs, and unavailable in headless CI images without a
  signed-in profile.
- **Vendor pinned unpacked builds instead:**
  - Freighter: build from a pinned tag of `stellar/freighter` (it's a yarn-workspace repo
    that produces `extension/build`), or download the corresponding GitHub Release asset
    if one is published as a zipped unpacked build.
  - Albedo: same approach against `stellar-expert/albedo`.
  - Cache these vendored builds in CI (keyed by pinned version) so normal PR runs don't
    re-download/re-build every time — only the scheduled canary and deliberate version
    bumps touch the network.
- **`launchPersistentContext` requirements for MV3:** must run `headless: false` (or
  Chrome's new `--headless=new` mode, which does support extensions as of recent Chrome
  versions — worth explicitly testing since this changes CI image requirements), a real
  temp `userDataDir`, and ideally `channel: 'chromium'` or `'chrome'` pinned to a known
  Chrome version for reproducibility (extension APIs and popup behavior can differ across
  Chrome milestones too — this is a second axis of drift beyond the wallets themselves).

See `poc/download-wallet-release.sh` for a working pinned-fetch script.

---

## 8. Version Pinning & Reproducibility

- Pin exact wallet versions in a single source of truth: `tests/fixtures/wallet-versions.json`.
- CI's default (blocking) run uses only the pinned versions — never "latest."
- The scheduled canary (§3 Option A) runs against `latest` *in addition to* the pin, and
  its failures open an issue rather than blocking any PR.
- Every pin bump is its own PR, reviewed like a dependency upgrade, with the compatibility
  matrix (§4) and protocol schema (§5) updated in the same diff.
- Record the exact Chrome/Chromium build used alongside the wallet pins — both are
  independent sources of behavioral drift.

---

## 9. Safe Test-Account Handling

- **Testnet only, always.** Never point any automated wallet flow at a mainnet-funded
  account, even a "dust" one — automated browser contexts are not a safe secret boundary.
- **Ephemeral keypairs generated per test run**, funded via Friendbot, discarded after.
  Do not commit a long-lived testnet secret key to the repo, even for testnet — treat it
  as a habit-forming anti-pattern that risks copy-paste onto mainnet later.
- If a stable funded testnet account is genuinely needed (e.g. for Albedo's session/login
  flow, which persists state), store its secret in the CI secret manager, not in fixtures,
  and rotate it on a schedule.
- Redact all captured protocol payloads (§5, golden captures) of any secret key or session
  token before committing them as fixtures.

---

## 10. CI vs Scheduled/Manual Recommendation

| Cadence | What runs | Blocking? |
|---|---|---|
| Every PR | Synthetic fixture tests (existing) + schema/contract validation against pinned-version golden captures (§5) | Yes |
| Nightly | Real pinned-version extension boot + interception test (§8 PoC) against Freighter and Albedo | No — files an issue |
| Weekly | Same as nightly, but against `latest` published wallet versions | No — files an issue |
| On wallet changelog change | Manual exploratory pass (popup visuals, timing, new intents) per §11 | N/A (human process) |
| On deliberate version bump | Full matrix update (§4) + schema update (§5), reviewed as a normal PR | Yes, as a gate on merging the bump |

---

## 11. Practical Follow-Up Plan

1. **Week 1:** Land `poc/protocol-contract.schema.ts` and wire it into the existing
   synthetic test as a schema-validation assertion (zero new infra, immediate value).
2. **Week 1–2:** Vendor a pinned Freighter build via `poc/download-wallet-release.sh`,
   get the real-extension PoC (`poc/real-freighter-version.spec.ts`) green in CI as a
   manually-triggered job.
3. **Week 2–3:** Populate the compatibility matrix (§4) for real, by running the PoC and
   recording actual observed values — replace every "confirm against current release" cell.
4. **Week 3:** Promote the real-Freighter PoC to a nightly scheduled job (non-blocking).
5. **Week 4:** Repeat 2–4 for Albedo, explicitly documenting its structurally different
   (popup-first, no ambient interception point) threat model rather than forcing it into
   the same fixture shape as Freighter.
6. **Ongoing:** subscribe to `stellar/freighter` and `stellar-expert/albedo` release
   notifications; each release triggers the manual pass in §10's third row before any
   version-bump PR is opened.

---

## Appendix: Acceptance Criteria Cross-Reference

- ✅ Synthetic coverage and blind spots documented — §2
- ✅ Real-wallet testing options compared — §3
- ✅ Protocol-drift detection specified — §5, §6
- ✅ Secret-handling requirements documented — §9
- ✅ Practical follow-up plan produced — §11
- ✅ Wallet compatibility matrix — §4
- ✅ Proof of concept — `poc/` (see below)