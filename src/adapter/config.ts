/** Per-lookup budget. The review deadline is minutes long; one score must not stall the popup. */
export const ORACLE_TIMEOUT_MS = 5_000
export const ORACLE_CACHE_TTL_MS = 180_000
export const ORACLE_CACHE_MAX_ENTRIES = 100
export const ORACLE_BREAKER_FAILURE_THRESHOLD = 5
export const ORACLE_BREAKER_COOLDOWN_MS = 30_000
