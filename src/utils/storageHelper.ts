export interface TrustedAddressStore {
  trustedAddresses: string[]
}

export const TRUSTED_ADDRESSES_KEY = 'trustedAddresses'

let fallbackTrusted: string[] = []

function hasChromeStorage(): boolean {
  return Boolean(globalThis.chrome?.storage?.local)
}

export async function getTrustedAddresses(): Promise<string[]> {
  if (hasChromeStorage()) {
    const stored = await chrome.storage.local.get(TRUSTED_ADDRESSES_KEY)
    const addresses = stored[TRUSTED_ADDRESSES_KEY]
    return Array.isArray(addresses) ? addresses : []
  }

  return fallbackTrusted
}

export async function addTrustedAddress(address: string): Promise<void> {
  const current = await getTrustedAddresses()
  if (current.includes(address)) return

  const next = [...current, address]
  if (hasChromeStorage()) {
    await chrome.storage.local.set({ [TRUSTED_ADDRESSES_KEY]: next })
  } else {
    fallbackTrusted = next
  }
}

export async function removeTrustedAddress(address: string): Promise<void> {
  const next = (await getTrustedAddresses()).filter((item) => item !== address)
  if (hasChromeStorage()) {
    await chrome.storage.local.set({ [TRUSTED_ADDRESSES_KEY]: next })
  } else {
    fallbackTrusted = next
  }
}
