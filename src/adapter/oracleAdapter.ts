import { DEFAULT_GET_SCORE_TIMEOUT_MS } from './config';

/**
 * Simple in-memory LRU cache with TTL for score values.
 */
class ScoreCache {
  private maxSize: number;
  private ttlMs: number;
  private map: Map<string, { value: number; expiresAt: number }>;

  constructor(maxSize: number, ttlMs: number) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  get(key: string): number | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh LRU order
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: number): void {
    if (this.map.has(key)) this.map.delete(key);
    if (this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
    const expiresAt = Date.now() + this.ttlMs;
    this.map.set(key, { value, expiresAt });
  }
}

// Default cache configuration
const DEFAULT_TTL_MS = 180_000; // 3 minutes
const DEFAULT_MAX_CACHE_SIZE = 100;

/** Global cache instance used by getScore */
const scoreCache = new ScoreCache(DEFAULT_MAX_CACHE_SIZE, DEFAULT_TTL_MS);

/** Helper: sleep for ms */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Jittered backoff delay */
function jitter(base: number): number {
  const min = base / 2;
  const max = base * 1.5;
  return Math.random() * (max - min) + min;
}

/** Generic retry with exponential backoff and jitter. */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  attempts: number,
  baseDelayMs: number,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      attempt++;
      if (attempt > attempts) throw e;
      const delay = Math.pow(2, attempt - 1) * baseDelayMs + jitter(baseDelayMs);
      await sleep(delay);
    }
  }
}

/** Simple circuit breaker. */
export class CircuitBreaker {
  private failureCount = 0;
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private lastFailureTime = 0;

  constructor(
    private failureThreshold: number,
    private windowMs: number,
    private cooldownMs: number,
  ) {}

  private now() {
    return Date.now();
  }

  private transitionToOpen() {
    this.state = 'OPEN';
    this.lastFailureTime = this.now();
    console.warn('Circuit breaker opened');
  }

  private transitionToHalfOpen() {
    this.state = 'HALF_OPEN';
    console.warn('Circuit breaker half‑open');
  }

  private transitionToClosed() {
    this.state = 'CLOSED';
    this.failureCount = 0;
    console.warn('Circuit breaker closed');
  }

  async exec<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    const now = this.now();

    if (this.state === 'OPEN') {
      if (now - this.lastFailureTime > this.cooldownMs) {
        this.transitionToHalfOpen();
      } else {
        return fallback;
      }
    }

    try {
      const result = await fn();
      // success – reset
      this.failureCount = 0;
      if (this.state !== 'CLOSED') this.transitionToClosed();
      return result;
    } catch (e) {
      // failure handling
      if (now - this.lastFailureTime > this.windowMs) {
        // reset window
        this.failureCount = 1;
        this.lastFailureTime = now;
      } else {
        this.failureCount++;
        this.lastFailureTime = now;
      }

      if (this.failureCount >= this.failureThreshold) {
        this.transitionToOpen();
      }
      throw e;
    }
  }
}

// Default breaker config (can be tuned)
export const circuitBreaker = new CircuitBreaker(5, 60_000, 30_000);

/**
 * Core score fetching logic (stub). Extracted for testing and cache usage.
 */
export async function fetchScore(destination: string): Promise<number> {
  // Simulate async work (the existing stub delay).
  await new Promise((resolve) => setTimeout(resolve, 150));
  return stubScoreFor(destination);
}

/**
 * Retrieves a risk score for a destination with a configurable timeout.
 * If the operation exceeds the timeout, it resolves with a fallback score of -1.
 * Supports in‑memory caching with optional bypass.
 */
export async function getScore(
  destination: string,
  options?: { timeoutMs?: number; signal?: AbortSignal; bypassCache?: boolean },
): Promise<number> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_GET_SCORE_TIMEOUT_MS;
  const signal = options?.signal ?? new AbortController().signal;
  const bypassCache = options?.bypassCache ?? false;

  if (!bypassCache) {
    const cached = scoreCache.get(destination);
    if (cached !== undefined) return cached;
  }

  const controller = new AbortController();
  const combinedSignal = options?.signal ?? controller.signal;

  // Timeout handling
  const timeoutPromise = new Promise<never>((_, reject) => {
    const id = setTimeout(() => {
      controller.abort();
      reject(new Error('Timeout'));
    }, timeoutMs);
    combinedSignal.addEventListener('abort', () => clearTimeout(id));
  });

  const fetchFn = () => fetchScore(destination);
  // Wrap fetch with retry logic (max 2 retries, base 200ms)
  const scorePromise = retryWithBackoff(fetchFn, 2, 200);

  // Execute with circuit breaker, fallback -1 on open
  return await circuitBreaker.exec(async () => {
    const result = await Promise.race([scorePromise, timeoutPromise]);
    // Cache successful result
    scoreCache.set(destination, result as number);
    return result as number;
  }, -1);
}


/** Simple deterministic stub used by the current implementation. */
function stubScoreFor(destination: string): number {
  let hash = 0;
  for (let i = 0; i < destination.length; i++) {
    hash = (hash * 31 + destination.charCodeAt(i)) >>> 0;
  }
  return hash % 101;
}
