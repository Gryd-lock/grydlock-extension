# Spike 0117: Cross-browser extension compatibility

- **Status:** Complete — recommendation ready for maintainer decision
- **Issue:** #117
- **Date:** 2026-08-17
- **Applies to:** extension version `0.1.0` and current `main`
- **Scope:** Chromium-family browsers and Firefox Desktop. Safari and mobile are assessed only far enough to justify excluding them.

## Question

What browser-support strategy is viable for Chromium browsers and Firefox without weakening interception or security guarantees?

## Summary of the recommendation

**Support the Chromium family as tier 1 today, and treat Firefox as a tier 2 target gated behind a runtime-verified proof of concept — not a manifest port.**

Concretely:

1. **Chromium family (Chrome, Edge, Brave, Opera, Vivaldi): supported.** Every API and manifest key in use is Chromium-standard. The only work required is honesty in the store listing and README about which browsers have actually been exercised in CI.
2. **Firefox: feasible on Firefox 128+, with four blocking prerequisites** — a Firefox manifest variant (event page instead of service worker, `browser_specific_settings.gecko.id`), a thin runtime adapter for the `chrome.*`/`browser.*` and callback/promise split, an event-page-safe pending-decision store, and a **host-permission check with a visible degraded state**, because Firefox MV3 lets the user revoke host access at any time and Gryd Lock would otherwise fail silently and invisibly.
3. **Do not ship Firefox support until the ordering and lifecycle behaviors in the "must be measured" list below are verified in a real browser.** They cannot be settled from documentation, and each one maps directly to a security objective in the threat model.
4. **Safari: out of scope.** It requires a native Xcode app wrapper, a paid developer account, and a separate review pipeline, for a wallet population that barely overlaps with Freighter and Albedo.
5. **Firefox for Android: out of scope.** The `windows` API is unavailable there, so the review-window flow has no implementation.

The honest position after this spike: a Firefox port is a **medium** amount of work with a **small number of genuinely unknown risks**, and the unknowns are exactly the ones that decide whether the warning flow still holds. Documentation answers the API questions; only a running browser answers the ordering ones.

## Required API inventory

Extracted from `main`. Every `chrome.*` call site in shipped code is listed.

| API                                                       | Call sites                                                                                                         | Chromium       | Firefox            | Notes                                                                                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chrome.runtime.onMessage.addListener` + `return true`    | [`background.ts:87`](../../src/background/background.ts)                                                           | Yes            | Yes                | Firefox supports the `sendResponse` + `return true` pattern. It must stay a top-level, synchronously registered listener for event-page revival.                                    |
| `chrome.runtime.sendMessage`                              | [`bridgeEntry.ts:23`](../../src/intercept/bridgeEntry.ts), [`App.tsx:103`](../../src/popup/App.tsx)                | Yes (callback) | Yes                | Callback form works via the `chrome` compatibility alias; `browser.*` returns a promise. The adapter should pick one shape.                                                         |
| `chrome.runtime.getURL`                                   | [`background.ts:79`](../../src/background/background.ts)                                                           | Yes            | Yes                | Firefox returns a `moz-extension://<uuid>/` URL where the UUID is per-install, not per-extension. Nothing in the code assumes a stable extension origin, which is worth preserving. |
| `chrome.action.setBadgeText` / `setBadgeBackgroundColor`  | [`background.ts:27,47,48`](../../src/background/background.ts)                                                     | Yes            | Yes (Firefox 109+) | Firefox keeps `page_action` alongside `action`; Gryd Lock only uses `action`, so no change.                                                                                         |
| `chrome.windows.create({ type: 'popup', width, height })` | [`background.ts:78`](../../src/background/background.ts)                                                           | Yes            | Yes (Desktop only) | Not available on Firefox for Android — the review window has no fallback there.                                                                                                     |
| `chrome.storage.local` get/set/remove                     | [`history.ts:22,29,33`](../../src/lib/history.ts), [`storageHelper.ts:15,29,38`](../../src/utils/storageHelper.ts) | Yes            | Yes                | Firefox `storage.local` is IndexedDB-backed; quota behavior differs but is far above the 200-entry history.                                                                         |
| `crypto.randomUUID`                                       | [`mainWorldEntry.ts`](../../src/intercept/mainWorldEntry.ts)                                                       | Yes            | Yes                | Runs in the MAIN world, so it is the page's `crypto`. Available in both under HTTPS and on `localhost`.                                                                             |
| `window.open` monkey-patch                                | [`albedoMainWorldEntry.ts`](../../src/intercept/albedoMainWorldEntry.ts)                                           | Yes            | Yes                | Web API, not an extension API; the Proxy-based interception is standard JS and portable.                                                                                            |
| `window.postMessage` protocol                             | interceptors and [`bridgeEntry.ts`](../../src/intercept/bridgeEntry.ts)                                            | Yes            | Yes                | Portable. Same page-visibility caveat in both browsers.                                                                                                                             |

**Conclusion of the inventory:** no API in use is missing from Firefox. No `chrome.scripting`, `chrome.declarativeNetRequest`, `chrome.offscreen`, `chrome.tabs`, or `chrome.webRequest` usage exists, which removes the usual MV3 porting pain. The port is blocked by _manifest and lifecycle_ differences, not by missing capabilities.

## Manifest key inventory

| Key (current [`manifest.json`](../../manifest.json))        | Chromium           | Firefox                                          | Required change                                                                                                                                                                                                                                 |
| ----------------------------------------------------------- | ------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest_version: 3`                                       | Yes                | Yes (Firefox 109+)                               | None                                                                                                                                                                                                                                            |
| `background.service_worker`                                 | Yes                | **No**                                           | Add `background.scripts: ["background.js"]`. Firefox 121+ starts the background page even when `service_worker` is also present, so one manifest can technically carry both; a separate Firefox manifest is still cleaner for store validation. |
| `content_scripts[].world: "MAIN"`                           | Yes                | Yes (**Firefox 128+**)                           | Sets the minimum supported Firefox version. `strict_min_version: "128.0"` is mandatory, otherwise the interceptor silently runs in the isolated world on older releases and never sees wallet traffic.                                          |
| `content_scripts[].run_at: "document_start"`                | Yes                | Yes                                              | None                                                                                                                                                                                                                                            |
| `action.default_popup`, `icons`                             | Yes                | Yes                                              | None                                                                                                                                                                                                                                            |
| `options_ui.open_in_tab`                                    | Yes                | Yes                                              | None                                                                                                                                                                                                                                            |
| `permissions: ["storage", "windows"]`                       | Yes                | `storage` yes; `windows` is **not a permission** | Firefox exposes the `windows` API without a permission entry and warns on unknown permission strings. Drop `windows` from the Firefox manifest. (Chromium also does not require it — it is inert there too.)                                    |
| `host_permissions: ["<all_urls>"]`                          | Granted at install | **Revocable at runtime**                         | Firefox 127+ prompts at install, but the user can revoke per-site or entirely from `about:addons` at any time. This is the single most consequential difference; see the security analysis.                                                     |
| `content_security_policy.extension_pages`                   | Yes                | Yes                                              | None. Current policy (`script-src 'self'; object-src 'self'`) satisfies both.                                                                                                                                                                   |
| `browser_specific_settings.gecko.id` / `strict_min_version` | Ignored            | **Required to publish**                          | Must be added for AMO.                                                                                                                                                                                                                          |

## Compatibility matrix

| Concern                                       | Chrome / Edge / Brave      | Firefox 128+ Desktop                          | Firefox Android       | Safari                |
| --------------------------------------------- | -------------------------- | --------------------------------------------- | --------------------- | --------------------- |
| MV3 support                                   | Yes                        | Yes                                           | Yes                   | Yes (with wrapper)    |
| MAIN-world content script at `document_start` | Yes                        | Yes (128+)                                    | Yes (128+)            | Yes                   |
| Background model                              | Service worker             | Event page (`scripts`)                        | Event page            | Service worker        |
| `windows.create` review popup                 | Yes                        | Yes                                           | **No API**            | Yes                   |
| Badge on toolbar action                       | Yes                        | Yes                                           | Limited               | Yes                   |
| Host access stability                         | Granted at install, stable | **User-revocable at any time**                | Same                  | Per-site prompts      |
| Freighter available                           | Yes                        | Yes (AMO listing)                             | No                    | No                    |
| Albedo (web-based, `window.open`)             | Yes                        | Yes                                           | Popup flow unreliable | Yes                   |
| Automated extension E2E                       | Playwright (in use)        | Requires a different harness (see CI section) | None                  | None practical        |
| Packaging                                     | Unsigned ZIP for the store | **Must be signed by AMO**                     | Same                  | Xcode + Apple account |
| Recommendation                                | **Tier 1: supported**      | **Tier 2: after PoC**                         | Not supported         | Not supported         |

## Injection ordering and messaging assumptions

The threat model's review-before-signing objective rests on one assumption: Gryd Lock's MAIN-world listener runs and captures the wallet's `SUBMIT_TRANSACTION` message before the wallet's own content script handles it. [`mainWorldEntry.ts`](../../src/intercept/mainWorldEntry.ts) already documents that Chrome does not guarantee cross-extension injection order. Porting does not create this race — but it does mean the race's _outcome_ is a per-browser empirical property that has never been measured on Firefox.

Assumptions, and what porting does to each:

| Assumption                                                                                                        | Chromium status                                     | Firefox expectation                                                    | Confidence                 |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------- |
| MAIN-world script runs before page scripts at `document_start`                                                    | Holds                                               | Expected to hold; same documented contract                             | High                       |
| Gryd Lock's `message` listener (capture phase) runs before the wallet extension's listener                        | Not guaranteed; works in practice                   | **Unknown** — different extension startup and injection implementation | **Low — must be measured** |
| `event.stopImmediatePropagation()` prevents another extension's already-registered listener from seeing the event | Holds within a world for listeners registered later | Expected to hold — same DOM semantics                                  | Medium                     |
| `event.source === window` distinguishes same-window messages                                                      | Holds                                               | Holds                                                                  | High                       |
| `chrome.runtime.sendMessage` callback fires exactly once and the port stays open with `return true`               | Holds                                               | Holds, but the event page can be suspended mid-flight                  | Medium                     |
| A pending decision survives in the background's in-memory `Map` for the life of the review                        | Already fragile (MV3 termination, issue `#3`)       | **More fragile** — event pages unload on idle                          | **Low — must be measured** |
| The review popup can message the background after an idle gap                                                     | Holds (wakes worker)                                | Expected to wake the event page                                        | Medium                     |

**The two low-confidence rows are the gate.** If Freighter's listener wins the race on Firefox, the extension provides no protection while appearing installed and healthy — the worst possible failure mode for a security tool, and worse than not shipping. If event-page suspension drops pending decisions more aggressively than MV3 termination does, the dApp's signing promise hangs or resolves to `cancel` unexpectedly.

Neither can be settled from documentation, and neither was validated in this spike: the analysis here is source- and documentation-based, and no Firefox build was produced or run. That is exactly why the recommendation is "PoC gated" rather than "port it".

## Security analysis

Porting must not weaken any objective in [`docs/threat-model.md`](../threat-model.md). Assessment per objective:

| Objective               | Effect of Firefox support                                                                                      | Required control                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Review-before-signing   | **At risk** from the unmeasured ordering race, and separately from revocable host permissions                  | Runtime self-test (issue `#8`) becomes a _release blocker_ for Firefox, not a nice-to-have |
| Request integrity       | Unchanged — re-post logic is pure DOM messaging                                                                | Regression tests reused as-is                                                              |
| Cancellation integrity  | Unchanged                                                                                                      | Same                                                                                       |
| Display integrity       | Unchanged; extension pages are same-origin-isolated in both                                                    | Same                                                                                       |
| Decision binding        | **At risk** from event-page suspension losing the pending map                                                  | Persist recoverable pending metadata before Firefox ships (overlaps issue `#3`)            |
| No key custody          | Unchanged                                                                                                      | None                                                                                       |
| Predictable degradation | **At risk** — a revoked host permission produces silence, not a degraded state                                 | `permissions.contains()` check plus an explicit "not protecting this site" UI state        |
| Finite interruption     | **At risk** — if the event page unloads while the dApp awaits a response, the page may wait forever            | Timeout on the page side, not only the background side                                     |
| Least privilege         | **Improved** on Firefox — revocable host permissions let a user narrow Gryd Lock to the sites they transact on | Support per-site grants rather than assuming `<all_urls>`                                  |

Two Firefox-specific properties are genuinely _better_ for security: host permissions are user-controllable, and AMO's mandatory signing and source review raise the bar against a counterfeit build. Two are worse: the silent-revocation failure mode, and a second distribution channel to defend (AMO credentials, review turnaround during an incident).

One thing the port does **not** change: the MAIN-world interceptor is equally visible to page scripts in both browsers. Firefox's `world: "MAIN"` documentation carries the same warning MDN gives everyone, and it is already reflected in the threat model.

## Required polyfills and adapters

1. **Namespace and call-shape adapter (required).** Firefox exposes `chrome.*` as a compatibility alias, but promise-versus-callback behavior varies per API and per version. Rather than adding `webextension-polyfill` as a runtime dependency to a security-sensitive extension — new supply-chain surface, new bundle weight in a build with 3–5 KB content-script budgets — write a ~40-line internal module exposing only the six calls the extension actually makes. It stays inside the existing architecture guardrails and is trivially testable.

   ```ts
   // src/platform/runtime.ts (sketch)
   const api: typeof chrome = globalThis.browser ?? globalThis.chrome

   export const runtime = {
     sendMessage: (message: unknown): Promise<unknown> =>
       new Promise((resolve) => api.runtime.sendMessage(message, resolve)),
     getURL: (path: string) => api.runtime.getURL(path),
     onMessage: api.runtime.onMessage,
   }
   ```

2. **No DOM or JS polyfills needed.** `crypto.randomUUID`, `Proxy`, `URLSearchParams`, and `structuredClone`-free messaging are all available in Firefox 128.

3. **Build target change.** [`scripts/build-extension.mjs`](../../scripts/build-extension.mjs) targets `chrome111`. A Firefox bundle needs `target: ['firefox128']` and a second output directory, with the existing content-script size budgets applied to both.

4. **Manifest generation.** Keep one source manifest and derive per-browser manifests in the build, so `validate-manifest.mjs` can check both and they cannot drift.

## Proof of concept: draft Firefox manifest

Specification-level, derived from the inventory above. It has **not** been loaded in Firefox; validating it is the first task of the follow-up work.

```json
{
  "manifest_version": 3,
  "name": "Gryd Lock",
  "version": "0.1.0",
  "description": "Warns before signing a Stellar transaction if the destination looks fraudulent.",
  "browser_specific_settings": {
    "gecko": {
      "id": "grydlock@gryd-lock.example",
      "strict_min_version": "128.0"
    }
  },
  "icons": {
    "16": "icons/icon16.png",
    "32": "icons/icon32.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  },
  "action": { "default_popup": "src/popup/index.html" },
  "options_ui": { "page": "src/history/index.html", "open_in_tab": true },
  "permissions": ["storage"],
  "background": { "scripts": ["background.js"] },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["mainWorld.js"],
      "world": "MAIN",
      "run_at": "document_start"
    },
    {
      "matches": ["<all_urls>"],
      "js": ["albedoMainWorld.js"],
      "world": "MAIN",
      "run_at": "document_start"
    },
    { "matches": ["<all_urls>"], "js": ["bridge.js"], "run_at": "document_start" }
  ],
  "host_permissions": ["<all_urls>"],
  "content_security_policy": { "extension_pages": "script-src 'self'; object-src 'self'" }
}
```

Differences from the Chromium manifest: `browser_specific_settings` added, `background.service_worker` replaced with `background.scripts`, `windows` dropped from `permissions`.

### Manual validation script for the PoC

Run in Firefox 128+ with `web-ext run` and Freighter installed, and record the result for each step:

1. Load the build; confirm both MAIN-world scripts and the bridge inject on a test page (`document_start`, before page scripts).
2. Trigger a Freighter `SUBMIT_TRANSACTION` from a test dApp. **Confirm Gryd Lock sees the request before Freighter does** — the ordering gate. Repeat across cold start, warm start, and reload, at least 20 trials.
3. Confirm the review window opens with the correct destination, asset, and tier.
4. Cancel; confirm Freighter never receives the request and the dApp promise rejects.
5. Proceed; confirm the request reaches Freighter unmodified and signing completes.
6. Idle for 60+ seconds with a review window open, then decide. **Confirm the decision still resolves** — the event-page gate.
7. Close the review window without deciding; confirm the dApp promise settles rather than hanging.
8. Revoke host access in `about:addons`, retry a signing request, and record exactly what the user sees. This is the degraded-state requirement.
9. Repeat 2–7 for the Albedo popup flow.
10. Verify the badge, options page, decision history, and trusted-address allowlist.

## CI requirements

Current CI runs lint, typecheck, coverage, manifest validation, build, and a Chromium Playwright E2E — and [`playwright.e2e.config.ts`](../../playwright.e2e.config.ts) hard-codes `browserName: 'chromium'` because Playwright loads extensions only in Chromium with a persistent context.

Proposed staging:

| Stage                        | Scope                                                                                                                                                                                                                                                                            | Cost                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **Now (no Firefox support)** | Build both bundles and validate both manifests in CI, even before Firefox ships, so the Firefox variant cannot silently rot                                                                                                                                                      | Seconds                           |
| **PoC phase**                | Add `web-ext lint` against the Firefox manifest as a required check; keep functional validation manual using the script above                                                                                                                                                    | Minutes                           |
| **If Firefox ships**         | Add a Firefox E2E job driving a temporary add-on install over the remote debugging protocol (`web-ext` + a Firefox-capable harness, since Playwright cannot load add-ons natively). Gate it as non-blocking for one release cycle to measure flakiness before making it required | Moderate; new harness to maintain |

Additional CI rules regardless of stage:

- `validate-manifest.mjs` should gain Firefox-specific assertions: `gecko.id` present, `strict_min_version >= 128.0`, `background.scripts` present, no `windows` permission entry.
- Content-script size budgets apply to the Firefox bundle too.
- The unit and component suites are browser-agnostic and need no duplication.

## Support recommendation and risks

**Recommendation:** publish and document Chromium-family support now. Treat Firefox as an explicitly experimental target, and commit to it only after the manual validation script passes — in particular steps 2, 6, and 8.

Risks accepted or deferred:

| Risk                                                                                                    | Severity | Handling                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Freighter wins the listener race on Firefox, leaving users unprotected but believing they are protected | **High** | PoC gate; ship nothing until measured. If it fails, the answer is a runtime self-test and an honest "not protecting" state, not a quiet release. |
| Silent host-permission revocation                                                                       | **High** | Blocking prerequisite: permission check plus visible degraded state                                                                              |
| Event-page suspension drops pending decisions                                                           | Medium   | Overlaps existing issue `#3`; fix once, benefits both browsers                                                                                   |
| Two store review pipelines slow security fixes                                                          | Medium   | Document expected AMO turnaround in the incident-response section of the threat model                                                            |
| Firefox CI harness flakiness                                                                            | Medium   | Introduce non-blocking first                                                                                                                     |
| Maintenance cost of a second manifest and adapter                                                       | Low      | Generate manifests from one source; keep the adapter minimal and internal                                                                        |
| Chromium-family forks (Brave, Opera) diverging                                                          | Low      | Same engine; spot-check at release                                                                                                               |

If maintainers want reach sooner than the PoC allows, the correct partial step is publishing to Edge Add-ons, which needs no code change at all.

## Acceptance criteria

- [x] Required APIs are inventoried — every `chrome.*` call site, plus manifest keys and web APIs the interception depends on.
- [x] Chromium/Firefox differences are documented — API, manifest, packaging, and lifecycle tables, plus a four-target matrix.
- [x] Ordering and messaging assumptions are evaluated — seven assumptions with per-browser confidence, and the two that block a release identified.
- [x] CI requirements are proposed — three staged levels plus manifest-validation additions.
- [x] Support recommendation and risks are recorded — tiered recommendation with a risk register and explicit exclusions for Safari and Firefox Android.

## Bounded follow-up work

1. **Firefox manifest generation and build target** (S) — derive both manifests from one source, add the `firefox128` esbuild target, extend `validate-manifest.mjs`.
2. **Platform runtime adapter** (S) — internal `src/platform/runtime.ts` with unit tests; no new dependency.
3. **Host-permission awareness and degraded state** (M) — check host access at runtime and surface an explicit unprotected state. Valuable on Chromium too, and a prerequisite for Firefox.
4. **Event-page-safe pending decisions** (M) — extends issue `#3` so decisions survive background suspension in both lifecycle models.
5. **Run the PoC validation script and record results** (M) — the go/no-go gate; publish the results in this document.
6. **Firefox CI harness** (M) — only after step 5 passes.

Out of scope: Safari, Firefox for Android, any new wallet integration, and any change to interception semantics undertaken solely to make a browser easier to support.

## Revisit criteria

- Firefox changes MV3 background or host-permission behavior.
- Freighter or Albedo change their page protocol or their Firefox distribution.
- A browser offers a deterministic ordering guarantee for content-script injection, which would remove the race that gates this work.
- Chromium ships a change that breaks MAIN-world injection at `document_start`.
- Demand for Safari or mobile becomes concrete enough to justify a native wrapper.
