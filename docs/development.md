# Development

Local setup, quality gates, releases and dependency policy. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the PR process.

### Develop

1. `npm ci` (also builds `grydlock-oracle-adapter` via postinstall)
2. `npm run build`, or `npm run dev` for a Vite dev server for the popup only. The content scripts
   and background worker need a real `chrome://extensions` load.
3. Load `dist/` unpacked (see [Try it](../README.md#quick-start)) and use `npm run demo` to send test requests.
4. In dev builds, `src/popup/index.html?dev=score&score=60` renders the warning with a slider over
   synthetic scores, for UI work. That route is compiled out of production builds and never calls
   an oracle.

### Quality Gates

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
- `src/history/main.tsx` — React entry-point boilerplate for the Options page.
- `src/tests/e2e/**` — legacy Playwright file, not part of the unit suite.
- `src/intercept/protocol.ts` — constant and type definitions only.

### Dependency Maintenance

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
require the CI `ci` job. Repository or organization Actions settings must also allow
the workflow token to approve pull requests. If those settings are absent, maintainers should merge
Dependabot PRs manually after `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`
pass.
