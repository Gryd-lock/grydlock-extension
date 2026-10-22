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

/**
 * Versioned, validated on-disk envelope for decision history.
 * Stored data is treated as untrusted: every field is re-validated on read.
 */
export interface HistoryEnvelope {
  schemaVersion: number
  revision: number
  entries: HistoryEntry[]
}

export const HISTORY_KEY = 'decisionHistory'
export const HISTORY_LIMIT = 200
export const HISTORY_SCHEMA_VERSION = 1

/** Typed error raised when persisted history cannot be trusted or written. */
export class HistoryStorageError extends Error {
  readonly code: 'corrupt' | 'write-failed' | 'read-failed'
  constructor(code: HistoryStorageError['code'], message: string) {
    super(message)
    this.name = 'HistoryStorageError'
    this.code = code
  }
}

const DECISIONS: readonly Decision[] = ['allow', 'warn', 'block']
const TIERS: readonly Tier[] = ['trusted', 'unknown', 'suspicious', 'dangerous']

function isDecision(value: unknown): value is Decision {
  return typeof value === 'string' && (DECISIONS as readonly string[]).includes(value)
}

function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value)
}

/** Validates a single untrusted record; returns null when it cannot be trusted. */
function validateEntry(raw: unknown): HistoryEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.destination !== 'string' || r.destination.length === 0) return null
  if (typeof r.score !== 'number' || !Number.isFinite(r.score)) return null
  if (!isTier(r.tier)) return null
  if (!isDecision(r.decision)) return null
  if (typeof r.timestamp !== 'number' || !Number.isFinite(r.timestamp)) return null
  const entry: HistoryEntry = {
    destination: r.destination,
    score: r.score,
    tier: r.tier,
    decision: r.decision,
    timestamp: r.timestamp,
  }
  if (typeof r.asset === 'string' && r.asset.length > 0) entry.asset = r.asset
  return entry
}

/** Validates an untrusted array of records, dropping any that fail validation. */
function validateEntries(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return []
  const out: HistoryEntry[] = []
  for (const item of raw) {
    const entry = validateEntry(item)
    if (entry) out.push(entry)
    if (out.length >= HISTORY_LIMIT) break
  }
  return out
}

/**
 * Normalizes whatever is stored under HISTORY_KEY into a validated envelope.
 * Handles the legacy bare-array format and any corrupt/unknown shapes without
 * throwing, so corruption can never crash the extension or inject records.
 */
function normalizeEnvelope(raw: unknown): HistoryEnvelope {
  if (Array.isArray(raw)) {
    // Legacy format: a bare array of entries with no schema/revision metadata.
    return { schemaVersion: HISTORY_SCHEMA_VERSION, revision: 0, entries: validateEntries(raw) }
  }
  if (typeof raw === 'object' && raw !== null) {
    const r = raw as Record<string, unknown>
    const revision = typeof r.revision === 'number' && Number.isFinite(r.revision) ? r.revision : 0
    return {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      revision,
      entries: validateEntries(r.entries),
    }
  }
  return { schemaVersion: HISTORY_SCHEMA_VERSION, revision: 0, entries: [] }
}

/** Prepends an entry, keeping the newest HISTORY_LIMIT entries. */
export function appendEntry(entries: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  return [entry, ...entries].slice(0, HISTORY_LIMIT)
}

async function readEnvelope(): Promise<HistoryEnvelope> {
  let stored: Record<string, unknown>
  try {
    stored = await chrome.storage.local.get(HISTORY_KEY)
  } catch (err) {
    throw new HistoryStorageError('read-failed', `Failed to read history: ${String(err)}`)
  }
  return normalizeEnvelope(stored[HISTORY_KEY])
}

export async function readHistory(): Promise<HistoryEntry[]> {
  const envelope = await readEnvelope()
  return envelope.entries
}

/**
 * Serializes mutations so concurrent recordDecision calls cannot lose records.
 * Each write re-reads the latest revision, appends, and bumps the revision.
 */
let writeChain: Promise<void> = Promise.resolve()

export function recordDecision(entry: HistoryEntry): Promise<void> {
  const validated = validateEntry(entry)
  if (!validated) {
    return Promise.reject(new HistoryStorageError('corrupt', 'Refusing to persist invalid history entry'))
  }
  const run = async (): Promise<void> => {
    const current = await readEnvelope()
    const next: HistoryEnvelope = {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      revision: current.revision + 1,
      entries: appendEntry(current.entries, validated),
    }
    try {
      await chrome.storage.local.set({ [HISTORY_KEY]: next })
    } catch (err) {
      throw new HistoryStorageError('write-failed', `Failed to write history: ${String(err)}`)
    }
  }
  const result = writeChain.then(run, run)
  // Keep the chain alive regardless of individual failures.
  writeChain = result.catch(() => undefined)
  return result
}

export async function clearHistory(): Promise<void> {
  try {
    await chrome.storage.local.remove(HISTORY_KEY)
  } catch (err) {
    throw new HistoryStorageError('write-failed', `Failed to clear history: ${String(err)}`)
  }
}
