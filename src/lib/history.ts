import type { Decision } from '../intercept/protocol'
import type { Tier } from './tiers'

export interface HistoryEntry {
  destination: string
  asset?: string
  score: number
  tier: Tier
  decision: Decision
  timestamp: number
}

export const HISTORY_KEY = 'decisionHistory'
export const HISTORY_LIMIT = 200

/** Prepends an entry, keeping the newest HISTORY_LIMIT entries. */
export function appendEntry(entries: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  return [entry, ...entries].slice(0, HISTORY_LIMIT)
}

export async function readHistory(): Promise<HistoryEntry[]> {
  const stored = await chrome.storage.local.get(HISTORY_KEY)
  const entries = stored[HISTORY_KEY]
  return Array.isArray(entries) ? entries : []
}

export async function recordDecision(entry: HistoryEntry): Promise<void> {
  const entries = await readHistory()
  await chrome.storage.local.set({ [HISTORY_KEY]: appendEntry(entries, entry) })
}

export async function clearHistory(): Promise<void> {
  await chrome.storage.local.remove(HISTORY_KEY)
}
