# Privacy & Data Handling Policy

Gryd Lock is built on a foundation of user trust. This document outlines how data is handled by the Gryd Lock browser extension, what information is processed, what is stored, and what is transmitted.

## Core Privacy Principle

**All transaction inspection, parsing, and analysis are performed entirely locally on your device.**

The current adapter is local-only. Before a live oracle is enabled, its transport and privacy
contract must be separately reviewed and documented. No diagnostics or health data leaves your
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

## 2. Data Transmitted (External Oracle Scoring)

To determine whether the destination account is fraudulent or associated with known scams, a single network request is made to the Gryd Lock Oracle.

- **What is sent**: **Only** the destination public key (e.g., `GBX...`).
- **What is NOT sent**: No transaction amount, source account, signatures, operation types, sequence numbers, memo fields, or user credentials are ever transmitted.
- **Purpose**: To retrieve a numerical risk score (0-100) indicating the safety level of the destination.

_Note: The network request is routed exclusively through the designated adapter boundary (`src/adapter/oracleAdapter.ts`)._

---

## 3. Data Stored (Local Only)

Gryd Lock persists the following local-only data in `chrome.storage.local` or `chrome.storage.session`. All persisted records are versioned, schema-validated on read, and treated as untrusted input; corruption is discarded rather than trusted.

### 3.1 Decision history

Each decision record retains the reviewed targets and findings that actually drove the warning (not
just the first target), the network, adapter name, evidence provenance and freshness, the displayed
state, the policy version, the decision, and the terminal reason. To minimize identifiers and time
precision, records store only the destination public key and asset code/issuer needed to explain the
decision, and timestamps are stored at coarse (hour) precision rather than exact times. History is
never transmitted and can be exported or cleared independently of other classes.

### 3.2 Trusted-target policy

Trusted targets are stored with their network and target type, a label, provenance, and an optional
expiry. Trust is scoped by network and type and never suppresses opaque, admin, authority, or
unavailable findings. Trusted entries are validated on read and can be exported or cleared
independently of history.

### 3.3 Protection state

Tab/frame numeric identifiers, supported adapter name, closed-set state, protocol version, and
coarse check time. No URL, account, XDR, request identifier, transaction, or browsing history is
stored.

### 3.4 Local diagnostics

Fixed hourly counters retained for seven days. Export contains only the fixed counter vocabulary,
coarse browser environment, coarse health state, and hour-rounded times. It contains no account,
destination, XDR, URL, request ID, fine timestamp, or arbitrary error text. Diagnostics are kept
separate from transaction history and are not bundled with it by default. Export is user initiated
and never uploads anything.

### 3.5 Retention, export, and deletion

Each data class (history, trust, diagnostics, protection state) has its own count, retention control,
export, and clear action. A clear-all action deletes every documented class. Per-class clearing is
isolated so clearing one class never affects another. Legacy records are migrated idempotently on
startup without inventing missing network or provenance; interrupted migrations are recovered on
restart.

Diagnostics are not part of signing. A storage or export failure never changes a signing decision
or adds critical-path latency, and storage failures are surfaced in the UI rather than silently
swallowed.

---

## 4. Architectural Enforcement & CI Verification

To guarantee that no accidental telemetry, logging, or alternative network calls are introduced in the future, Gryd Lock employs automated build-time and commit-time checks.

- **Restricted APIs**: Global browser networking APIs (`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`) are statically banned across the entire codebase except inside the designated adapter directory (`src/adapter/`).
- **Stellar SDK Server Restriction**: Direct connections to Stellar Horizon servers (`new Server(...)`) are restricted outside of the adapter directory.
- **CI Enforcement**: Any pull request introducing a network call outside the designated adapter boundary will trigger a failure in the linting workflow (`npm run lint`), blocking the merge.
