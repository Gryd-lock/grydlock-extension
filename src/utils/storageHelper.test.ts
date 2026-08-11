import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TRUSTED_ADDRESSES_KEY,
  addTrustedAddress,
  getTrustedAddresses,
  removeTrustedAddress,
} from './storageHelper'

describe('trusted address storage helper', () => {
  const originalChrome = globalThis.chrome
  const get = vi.fn()
  const set = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    get.mockResolvedValue({})
    set.mockResolvedValue(undefined)
    // @ts-expect-error test-only stub of the chrome extension API
    globalThis.chrome = { storage: { local: { get, set } } }
  })

  afterEach(() => {
    globalThis.chrome = originalChrome
  })

  it('returns an empty list when no trusted addresses are stored', async () => {
    expect(await getTrustedAddresses()).toEqual([])
    expect(get).toHaveBeenCalledWith(TRUSTED_ADDRESSES_KEY)
  })

  it('returns stored trusted addresses', async () => {
    get.mockResolvedValue({ [TRUSTED_ADDRESSES_KEY]: ['GDEST'] })
    expect(await getTrustedAddresses()).toEqual(['GDEST'])
  })

  it('adds a new trusted address without duplicating existing entries', async () => {
    get.mockResolvedValue({ [TRUSTED_ADDRESSES_KEY]: ['GOLD'] })
    await addTrustedAddress('GNEW')
    await addTrustedAddress('GOLD')

    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith({ [TRUSTED_ADDRESSES_KEY]: ['GOLD', 'GNEW'] })
  })

  it('removes a trusted address', async () => {
    get.mockResolvedValue({ [TRUSTED_ADDRESSES_KEY]: ['GKEEP', 'GREMOVE'] })
    await removeTrustedAddress('GREMOVE')
    expect(set).toHaveBeenCalledWith({ [TRUSTED_ADDRESSES_KEY]: ['GKEEP'] })
  })
})

describe('trusted address storage helper fallback store', () => {
  const originalChrome = globalThis.chrome

  beforeEach(() => {
    // @ts-expect-error test-only removal of chrome extension API
    globalThis.chrome = undefined
  })

  afterEach(() => {
    globalThis.chrome = originalChrome
  })

  it('stores addresses in memory when chrome.storage is unavailable', async () => {
    await addTrustedAddress('GFALLBACK')
    expect(await getTrustedAddresses()).toEqual(['GFALLBACK'])

    await removeTrustedAddress('GFALLBACK')
    expect(await getTrustedAddresses()).toEqual([])
  })
})
