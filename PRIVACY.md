# Privacy & Data Handling Policy

Gryd Lock is built on a foundation of user trust. This document outlines how data is handled by the Gryd Lock browser extension, what information is processed, what is stored, and what is transmitted.

## Core Privacy Principle

**All transaction inspection, parsing, and analysis are performed entirely locally on your device.** 

Except for a single, targeted external call to retrieve a risk score for the transaction's destination address, no data leaves your device.

---

## 1. Data Processed (Local Only)

When you initiate a transaction via Freighter (or a supported Stellar wallet interface), Gryd Lock intercepts the transaction request at the browser window level (`postMessage` layer). 

The following information is processed locally on your machine:
*   **Transaction XDR**: The raw unsigned transaction payload.
*   **Destination Account**: The Stellar public key (G-address) receiving the funds.
*   **Asset Code & Issuer**: Details of the asset being transferred (if not native XLM).
*   **User Decisions**: Whether you click **Proceed** or **Cancel** on the warning popup.

**None of this raw transaction information ever leaves your device.**

---

## 2. Data Transmitted (External Oracle Scoring)

To determine whether the destination account is fraudulent or associated with known scams, a single network request is made to the Gryd Lock Oracle.

*   **What is sent**: **Only** the destination public key (e.g., `GBX...`).
*   **What is NOT sent**: No transaction amount, source account, signatures, operation types, sequence numbers, memo fields, or user credentials are ever transmitted.
*   **Purpose**: To retrieve a numerical risk score (0-100) indicating the safety level of the destination.

*Note: The network request is routed exclusively through the designated adapter boundary (`src/adapter/oracleAdapter.ts`).*

---

## 3. Data Stored (Local Only)

Currently, Gryd Lock does not write or persist any data.
*   **In-Memory**: All variables, decoded payloads, and temporary score states exist only in-memory and are cleared as soon as the popup is closed or the transaction decision is made.
*   **Local Storage**: No history, preferences, or logs are written to `chrome.storage` or `localStorage` at this time.
    *   *Future Note*: If allowlist or local history features are introduced, they will be stored locally using `chrome.storage.local` and will never be synchronized or uploaded to any remote server.

---

## 4. Architectural Enforcement & CI Verification

To guarantee that no accidental telemetry, logging, or alternative network calls are introduced in the future, Gryd Lock employs automated build-time and commit-time checks.

*   **Restricted APIs**: Global browser networking APIs (`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`) are statically banned across the entire codebase except inside the designated adapter directory (`src/adapter/`).
*   **Stellar SDK Server Restriction**: Direct connections to Stellar Horizon servers (`new Server(...)`) are restricted outside of the adapter directory.
*   **CI Enforcement**: Any pull request introducing a network call outside the designated adapter boundary will trigger a failure in the linting workflow (`npm run lint`), blocking the merge.
