# Security Policy

Gryd Lock is an early-stage browser extension that participates in a financial signing flow. Security reports are welcome and should be handled privately so users are not exposed before a fix is available.

For the system's current guarantees, assumptions, and known gaps, see the [threat model](docs/threat-model.md).

## Supported versions

Gryd Lock has not published a stable production release. Security fixes are applied to the latest code on `main` and to the most recent officially published extension build, when one exists. Older commits, forks, and unofficial builds may not receive fixes.

| Version | Supported |
| --- | --- |
| Latest `main` / latest official build | Yes |
| Older commits or releases | No |
| Forks and modified builds | By their maintainers |

## Report a vulnerability privately

Use GitHub's private vulnerability reporting flow:

**[Report a vulnerability](https://github.com/Gryd-lock/grydlock-extension/security/advisories/new)**

Do not disclose exploit details in a public issue, pull request, discussion, social post, or chat channel. If GitHub does not present the private reporting form, open a public issue containing only the sentence “Please enable a private security reporting channel” and no vulnerability details.

A useful report includes:

- a concise description of the vulnerability and its security impact;
- the affected commit, release, browser, operating system, and wallet version;
- reproducible steps or a minimal proof of concept using synthetic accounts and transactions;
- whether exploitation requires a malicious page, another extension, a compromised wallet, user interaction, or a race condition;
- relevant logs, screenshots, or traces with secrets and personal transaction data removed;
- any suggested mitigation or coordinated-disclosure constraints.

Never send seed phrases, private keys, authentication tokens, production credentials, or real user transaction data. Maintainers will not ask for them.

## Response expectations

These are response targets, not contractual service-level guarantees:

- **Acknowledgement:** within 3 business days.
- **Initial triage:** within 7 calendar days.
- **Status updates:** at least every 14 calendar days while the report remains active.
- **Critical/high-severity remediation target:** as quickly as practical, normally within 30 days for critical issues and 60 days for high-severity issues.
- **Medium/low-severity remediation target:** normally within 90 days or the next planned hardening release.

Timelines may change when a fix depends on Chrome, Stellar, Freighter, or another third party. The maintainers will explain material delays through the private advisory.

## Severity and priority

Reports are prioritized by demonstrated impact and exploitability. Examples of high-priority findings include:

- bypassing or forging a Gryd Lock review outcome;
- causing a transaction to reach the wallet after the user selected **Cancel**;
- showing a destination, asset, network, score, or tier that does not correspond to the reviewed signing request;
- crossing the MAIN-world, isolated-world, background, or popup trust boundaries without authorization;
- executing attacker-controlled code in an extension page or service worker;
- leaking transaction data or extension state outside the documented flow;
- reliable denial of service that silently disables protection or indefinitely blocks signing;
- dependency or build-pipeline compromise affecting official artifacts.

A missing warning caused solely by the documented cross-extension registration-order race is a known limitation, but a new bypass, reliable exploitation technique, or improvement to detection is still valuable to report.

## Coordinated disclosure

Please give maintainers a reasonable opportunity to investigate, patch, and distribute an update before publishing details. The default coordinated-disclosure window is 90 days from acknowledgement, adjusted by mutual agreement for active exploitation, ecosystem dependencies, or store-review delays.

The maintainers will:

- keep the report and reporter identity private unless permission is granted;
- avoid requesting access to real funds or sensitive wallet material;
- credit the reporter in the advisory or release notes when requested and appropriate;
- publish an advisory after affected users can reasonably obtain the fix.

## Researcher safe harbor

Good-faith research is welcome when it:

- uses accounts, pages, transactions, and wallets you own or are authorized to test;
- avoids accessing, modifying, or retaining other users' data;
- avoids moving real funds or causing financial loss;
- avoids persistent denial of service, spam, popup flooding against other users, or Chrome Web Store abuse;
- stops testing and reports promptly if real user data or active exploitation is encountered;
- follows this private disclosure process.

The project will not pursue legal action for research conducted in good faith within these boundaries. This statement cannot authorize testing against third-party systems such as Freighter, Chrome, Stellar infrastructure, or a future oracle service; their own policies apply.

## Scope

### In scope

- code and configuration in this repository;
- the Freighter request interception and replay flow;
- MAIN-world and isolated-world `postMessage` handling;
- `chrome.runtime` messaging and MV3 service-worker state;
- XDR decoding and destination extraction;
- warning popup integrity and decision binding;
- manifest permissions and extension-page security policy;
- build scripts, CI, and dependencies used to produce official builds.

### Report to the relevant upstream project

- vulnerabilities in Freighter or another wallet without a Gryd Lock-specific impact;
- Chrome or Chromium vulnerabilities;
- Stellar protocol, Horizon, RPC, or SDK vulnerabilities;
- vulnerabilities limited to `grydlock-oracle-adapter` or another repository.

A cross-project issue may still be reported here when Gryd Lock makes the upstream weakness exploitable or fails to contain it.

### Generally out of scope

- social engineering with no technical bypass;
- warnings a user knowingly overrides;
- unsupported wallets or unofficial forks;
- findings that require an already-compromised browser, operating system, or wallet and add no Gryd Lock-specific impact;
- automated scanner output without a reproducible security consequence;
- denial of service against only your own local development instance;
- requests for a bug bounty. No bounty is promised unless a separate program explicitly states otherwise.
