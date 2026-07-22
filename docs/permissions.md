# Permissions Rationale

This document justifies the current `manifest.json` permission scope, per the Chrome Web Store review guidance on requesting the narrowest permissions a use case actually needs.

## Current scope

- `host_permissions: ["<all_urls>"]`
- Content scripts `mainWorld.js`, `albedoMainWorld.js` (MAIN world), and `bridge.js` all match `<all_urls>` and run at `document_start`.

## Why `<all_urls>` + `document_start` is the current requirement

Gryd Lock's job is to intercept a wallet-signing call (`window.freighterApi.signTransaction`, or Albedo's `window.open('https://albedo.link/confirm', ...)`, see README's "Albedo Interception") **before** the dApp's own code runs, on **whichever site the user happens to be dApp-browsing on**. Two properties of that follow directly:

1. **The set of sites is not knowable in advance.** Any site can embed Stellar wallet-signing integration (a dApp, a DEX front end, a marketplace) — there's no fixed, enumerable list of "Stellar dApp domains" the way there might be for, say, a single SaaS product's extension. Narrowing `matches` to a fixed domain list would silently stop protecting users on every dApp not on that list, which defeats the point of a warn-before-signing tool.
2. **Interception must happen at `document_start`, before user interaction.** `activeTab` only grants host access *after* the user invokes the extension (clicking the toolbar icon or a context-menu entry) for the current tab. A signing call frequently fires as part of a page's normal load or an early dApp-initiated flow, well before the user has any reason to click the extension icon — by the time `activeTab` access would exist, the moment to intercept has often already passed. This is a hard architectural constraint of MV3's `activeTab`, not a configuration choice.

## Alternatives considered

- **`activeTab` + `optional_host_permissions`, user-triggered "enable on this site":** evaluated and deferred. It would reduce the standing grant, but it reintroduces the timing problem above (the grant only exists after the user acts) and adds a per-site opt-in prompt to a tool whose value proposition is *automatic* protection on first visit to an unfamiliar dApp — most users skip optional-permission prompts, which would leave exactly the risky, unfamiliar sites unprotected. Revisiting this is tracked as a follow-up once there's Store review feedback or usage data to weigh against the UX cost.
- **Fixed domain allowlist:** rejected — see point 1 above; it doesn't match the actual threat model (an arbitrary/unknown dApp, not a known set of them).

## Mitigations already in place

- `content_security_policy` is scoped to `'self'` for extension pages.
- `permissions` (as opposed to `host_permissions`) is limited to `storage` and `windows` — no `tabs`, `webRequest`, `scripting`, or similar broader APIs are requested.
- MAIN-world injection is limited to the two files that need it (`mainWorld.js`, `albedoMainWorld.js`); `bridge.js` runs in the isolated content script world.

## Revisiting this

If the permission scope changes in the future (narrowed via `activeTab`/`optional_host_permissions`, or a documented allowlist), update this file, `README.md`, and the Chrome Web Store listing draft together, and re-verify the interception flow manually against a real Freighter install — the timing constraints above make this easy to silently break.
