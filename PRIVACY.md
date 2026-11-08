# Privacy & Data Handling Policy

Gryd Lock is built on a foundation of user trust. This document outlines how data is handled by the Gryd Lock browser extension, what information is processed, what is stored, and what is transmitted.

## Core Privacy Principle

**All transaction inspection, parsing, and analysis are performed entirely locally on your device.**

Destination scoring is **off by default**, and in that mode nothing leaves your device. The
"Testkit fixtures" source is also fully local. Only the opt-in, experimental "Soroban oracle"
source makes network requests (see section 2). No diagnostics or health data ever leaves your
device.

---

## 1. Data Processed (Local Only)

When you initiate a transaction via Freighter (or a supported Stellar wallet interface), Gryd Lock intercepts the transaction request at the browser window level (`postMessage` layer).

The following information is processed locally on your machine:

- **Transaction XDR**: The raw unsigned transaction payload.
- **Destination Account**: The Stellar public key (G-address) receiving the funds.
- **Asset Code & Issuer**: Details of the asset being transferred (if not native XLM).
- **User Decisions**: Whether you click **Proceed** or **Cancel** on the warning popup.

**None of this raw transaction information ever leaves your device.**

---

## 2. Data Transmitted (only with the Soroban oracle source)

You choose the score source on the extension's options page:

| Source                          | Network requests                                            |
| ------------------------------- | ----------------------------------------------------------- |
| Off (default)                   | None                                                        |
| Testkit fixtures (testnet only) | None. Scores come from a bundled copy of `grydlock-testkit` |
| Soroban oracle (experimental)   | Read-only RPC calls to the URL you enter                    |

With the Soroban source selected, each signing request triggers, per account destination,
`getNetwork`, `getLatestLedger` and `simulateTransaction` calls to the RPC URL you configured. The
simulated transaction invokes `get_score(destination)` on the contract ID you configured, from an
all-zero placeholder source account. It is never signed or submitted.

- **What is sent**: the destination account ID, the configured contract ID, and the standard
  request metadata (IP address, user agent) that any HTTPS request reveals to the RPC operator.
- **What is NOT sent**: no amount, source account, signatures, memo, other operations, the
  transaction you are signing, or any user identifier.
- **Who receives it**: only the RPC operator at the URL you entered. Gryd Lock runs no server.

_All network access is confined to `src/adapter/` (see section 4)._

---

## 3. Data Stored (Local Only)

Gryd Lock persists the following local-only data in `chrome.storage.local` or `chrome.storage.session`:

- **Decision history and trusted-address policy:** destination and decision history remain on the
  device and are never transmitted. They can be cleared independently.
- **Protection state:** tab/frame numeric identifiers, supported adapter name, closed-set state,
  protocol version, and coarse check time. No URL, account, XDR, request identifier, transaction,
  or browsing history is stored.
- **Local diagnostics:** fixed hourly counters retained for seven days. Export contains only the
  fixed counter vocabulary, coarse browser environment, coarse health state, and hour-rounded
  times. It contains no account, destination, XDR, URL, request ID, fine timestamp, or arbitrary
  error text. Export is user initiated and never uploads anything.

Diagnostics are not part of signing. A storage or export failure never changes a signing decision
or adds critical-path latency.

---

## 4. Architectural Enforcement & CI Verification

To guarantee that no accidental telemetry, logging, or alternative network calls are introduced in the future, Gryd Lock employs automated build-time and commit-time checks.

- **Restricted APIs**: Global browser networking APIs (`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`) are statically banned across the entire codebase except inside the designated adapter directory (`src/adapter/`).
- **Stellar SDK Server Restriction**: Direct connections to Stellar Horizon servers (`new Server(...)`) are restricted outside of the adapter directory.
- **CI Enforcement**: Any pull request introducing a network call outside the designated adapter boundary will trigger a failure in the linting workflow (`npm run lint`), blocking the merge.
