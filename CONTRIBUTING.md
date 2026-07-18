# Contributing to Gryd Lock

Thank you for helping improve Gryd Lock. This extension sits in a wallet-signing path, so changes must preserve clear trust boundaries, predictable degradation, and a reviewable explanation of any architectural tradeoffs.

## Before you start

- Search the issue tracker for overlapping work.
- For assigned issues, post the requested implementation plan and wait for assignment before opening a pull request.
- Keep each pull request focused on one issue or one coherent change.
- Do not include secrets, wallet seed phrases, private keys, real user transaction data, or production credentials in code, fixtures, screenshots, logs, or pull requests.

## Prerequisites

- Node.js 20, matching the CI environment.
- npm and a Chromium-based browser that supports Manifest V3 extensions.
- Freighter when manually testing the current signing interception flow.

## Local setup

```bash
git clone https://github.com/<your-user>/grydlock-extension.git
cd grydlock-extension
npm ci
npm run build
```

Load the generated `dist/` directory from `chrome://extensions`:

1. Enable **Developer mode**.
2. Choose **Load unpacked**.
3. Select the repository's `dist/` directory.

`npm run dev` starts the Vite development server for the default popup flow only. The MAIN-world interceptor, isolated-world bridge, and background service worker must be tested from a built extension loaded through `chrome://extensions`.

## Architecture guardrails

Gryd Lock crosses several browser execution contexts. Preserve these boundaries unless an accepted architecture decision explicitly changes them:

- `src/intercept/mainWorldEntry.ts` runs in the page's MAIN world. It can observe page-level wallet messages but cannot use `chrome.*` APIs.
- `src/intercept/bridgeEntry.ts` runs in the isolated extension world and owns the bridge to `chrome.runtime`.
- `src/background/background.ts` owns XDR decoding, risk lookup orchestration, pending-request state, and warning-window creation.
- `src/intercept/resolveOutcome.ts` is the browser-independent decision core and should remain testable without Chrome APIs.
- `src/popup/` renders information and captures the user's decision; it must not become a second implementation of decoding or scoring logic.

Changes must also preserve the product's current safety semantics:

- Gryd Lock warns; the user remains the final decision-maker.
- A transaction that cannot be assessed reliably degrades to `allow` rather than being silently blocked.
- Wallet-specific interception code must not duplicate the shared decode, score, decision, or popup pipeline.
- Messages crossing page, content-script, background, and popup boundaries must be validated and narrowly scoped.
- Do not move the Stellar SDK into the MAIN-world bundle without documenting the bundle-size and page-injection tradeoff.

## Development workflow

1. Create a focused branch from the latest `main`.
2. Make the smallest change that satisfies the issue's acceptance criteria.
3. Add or update tests at the boundary affected by the change.
4. Update README or architecture documentation when behavior, setup, trust assumptions, or extension boundaries change.
5. Run the complete quality-gate sequence before requesting review.

Formatting is managed by Prettier. Run `npm run format`, then review the resulting diff before committing.

## Testing expectations

Use the narrowest test that proves the behavior, while covering extension boundaries when they change:

- **Pure decision, tier, adapter, or decoding logic:** add or update Vitest unit tests.
- **Interception protocol changes:** test request recognition, outcome routing, and pass-through behavior with representative message shapes.
- **Background or runtime messaging changes:** cover success, malformed input, missing state, and cleanup or timeout paths where applicable.
- **Popup changes:** use Testing Library to cover visible states and user decisions.
- **Manifest, content-script, service-worker, or real-wallet changes:** include concise manual verification steps in the pull request because unit tests cannot reproduce every browser-extension interaction.
- **Bug fixes:** add a regression test that fails before the fix whenever the affected behavior is automatable.

Tests and fixtures must use synthetic XDR, addresses, scores, and request identifiers. Never commit real user transaction data.

## Quality gates

Run the same commands CI runs:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

A pull request is not ready for review while any gate is failing. Do not weaken lint, type, test, or build configuration merely to make a change pass.

## Architecture Decision Records

Use an Architecture Decision Record (ADR) when a change creates or materially changes a long-lived technical constraint. Examples include:

- introducing or changing a shared abstraction such as the proposed `WalletAdapter` interface;
- changing the MAIN-world, isolated-world, background, or popup responsibilities;
- changing interception, replay, pass-through, cancellation, or graceful-degradation semantics;
- changing message contracts or trust boundaries between browser contexts;
- adopting a major dependency, build strategy, persistence model, or security control;
- making a decision that multiple wallet integrations or future contributors must follow.

An ADR is usually unnecessary for a localized bug fix, test addition, copy change, dependency patch, or refactor that preserves existing boundaries and behavior.

### ADR process

1. Copy [`docs/adr/0000-template.md`](docs/adr/0000-template.md) to `docs/adr/NNNN-short-title.md`, using the next available four-digit number.
2. Set the status to **Proposed** and describe the context, decision drivers, considered options, decision, consequences, and validation plan.
3. Link the motivating issue and include the proposed ADR in the same pull request as the architectural implementation, or in a documentation-first pull request when maintainers need to agree before implementation begins.
4. Request explicit maintainer review of the decision, not only the code.
5. After approval, change the status to **Accepted** and add the ADR to [`docs/adr/README.md`](docs/adr/README.md).
6. Do not rewrite an accepted decision to hide its history. Create a new ADR that supersedes it, and cross-link both records.

The wallet-generalization work in issue `#28` is a concrete example: the `WalletAdapter` responsibilities, lifecycle, message contract, and invariants should be proposed in an ADR before wallet-specific implementations depend on them.

## Pull request checklist

Before requesting review, confirm:

- [ ] The pull request is scoped to one issue or coherent change and references it with `Closes #<number>` when appropriate.
- [ ] The description explains what changed, why, user/developer impact, and relevant tradeoffs.
- [ ] `npm run lint` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes.
- [ ] `npm run build` passes.
- [ ] New or changed behavior has unit, integration, or manual coverage appropriate to the affected boundary.
- [ ] Interception, background messaging, and popup changes include regression coverage and manual verification notes where needed.
- [ ] Existing tier mapping, pass-through, proceed, cancel, and graceful-degradation behavior has not regressed.
- [ ] README and related documentation reflect user-facing, setup, security, or architectural changes.
- [ ] An ADR is included for architectural decisions, or the pull request explains why one is unnecessary.
- [ ] No secrets, private keys, seed phrases, production credentials, or real user transaction data are present.
- [ ] The diff contains no unrelated generated files, formatting churn, or dependency changes.

## Review and follow-up

Respond to review comments with either a code/documentation update or a clear explanation. When a review changes an architectural decision, update the proposed ADR before the pull request is approved.
