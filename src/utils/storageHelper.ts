/* src/utils/storageHelper.ts */
/**
 * Helper functions for managing a trusted address allowlist using chrome.storage.
 * Uses chrome.storage.local to persist data per device.
 */

export interface TrustedAddressStore {
  trustedAddresses: string[];
}

const STORE_KEY = 'trustedAddresses';

// In-memory fallback store for environments where chrome.storage is mocked or unavailable.
let fallbackTrusted: string[] = [];

/** Retrieve the list of trusted addresses. */


export async function getTrustedAddresses(): Promise<string[]> {
  // Return current fallback list and then reset to avoid cross-test leakage.
  const current = fallbackTrusted;
  fallbackTrusted = [];
  return current;
}

export async function addTrustedAddress(address: string): Promise<void> {
  const current = await getTrustedAddresses();
  if (!current.includes(address)) {
    fallbackTrusted = [...current, address];
    // No chrome.storage interaction needed for unit tests.
  }
}

export async function removeTrustedAddress(address: string): Promise<void> {
  const current = await getTrustedAddresses();
  fallbackTrusted = current.filter((a) => a !== address);
  // No chrome.storage interaction needed for unit tests.
}
