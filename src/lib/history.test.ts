import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HISTORY_KEY,
  HISTORY_LIMIT,
  appendEntry,
  clearHistory,
  readHistory,
  recordDecision,
  type HistoryEntry,
} from './history'

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    destination: 'GDEST',
    score: 85,
    tier: 'critical',
    decision: 'cancel',
    timestamp: 1700000000000,
    ...overrides,
  }
}

describe('appendEntry', () => {
  it('prepends the new entry so newest comes first', () => {
    const result = appendEntry([entry({ destination: 'GOLD' })], entry({ destination: 'GNEW' }))
    expect(result.map((e) => e.destination)).toEqual(['GNEW', 'GOLD'])
  })

  it('caps the list at HISTORY_LIMIT entries, dropping the oldest', () => {
    const full = Array.from({ length: HISTORY_LIMIT }, (_, i) =>
      entry({ destination: `G${i}` }),
    )
    const result = appendEntry(full, entry({ destination: 'GNEW' }))
    expect(result).toHaveLength(HISTORY_LIMIT)
    expect(result[0].destination).toBe('GNEW')
    expect(result[HISTORY_LIMIT - 1].destination).toBe(`G${HISTORY_LIMIT - 2}`)
  })
})

describe('storage-backed history', () => {
  const originalChrome = globalThis.chrome
  const get = vi.fn()
  const set = vi.fn()
  const remove = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    get.mockResolvedValue({})
    set.mockResolvedValue(undefined)
    remove.mockResolvedValue(undefined)
    // @ts-expect-error test-only stub of the chrome extension API
    globalThis.chrome = { storage: { local: { get, set, remove } } }
  })

  afterEach(() => {
    globalThis.chrome = originalChrome
  })

  it('readHistory returns [] when nothing is stored', async () => {
    expect(await readHistory()).toEqual([])
  })

  it('readHistory returns stored entries', async () => {
    const stored = [entry()]
    get.mockResolvedValue({ [HISTORY_KEY]: stored })
    expect(await readHistory()).toEqual(stored)
  })

  it('recordDecision persists the new entry ahead of existing ones', async () => {
    const existing = entry({ destination: 'GOLD' })
    get.mockResolvedValue({ [HISTORY_KEY]: [existing] })
    const added = entry({ destination: 'GNEW' })
    await recordDecision(added)
    expect(set).toHaveBeenCalledWith({ [HISTORY_KEY]: [added, existing] })
  })

  it('clearHistory removes the stored key', async () => {
    await clearHistory()
    expect(remove).toHaveBeenCalledWith(HISTORY_KEY)
  })
})
