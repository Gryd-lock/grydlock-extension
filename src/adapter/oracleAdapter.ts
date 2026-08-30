import { DEFAULT_GET_SCORE_TIMEOUT_MS } from './config';
import { isValidScore } from '../lib/tiers';

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
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: number): void {
    if (this.map.has(key)) this.map.delete(key);
    if (this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}

const DEFAULT_TTL_MS = 180_000;
const DEFAULT_MAX_CACHE_SIZE = 100;
const scoreCache = new ScoreCache(DEFAULT_MAX_CACHE_SIZE, DEFAULT_TTL_MS);
const inFlightScores = new Map<string, Promise<number>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(base: number): number {
  const min = base / 2;
  const max = base * 1.5;
  return Math.random() * (max - min) + min;
}

async function retryWithBackoff<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  attempts: number,
  baseDelayMs: number,
  signal?: AbortSignal,
): Promise<T> {
  let attempt = 0;
  while (true) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      return await fn(signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      attempt++;
      if (attempt > attempts) throw e;
      const delay = Math.pow(2, attempt - 1) * baseDelayMs + jitter(baseDelayMs);
      await sleep(delay);
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
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
export async function fetchScore(destination: string, options?: { signal?: AbortSignal }): Promise<number> {
  if (options?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  await new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, 150);
    const onAbort = () => {
      clearTimeout(id);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    options?.signal?.addEventListener('abort', onAbort, { once: true });
  });

  const score = stubScoreFor(destination);
  if (!isValidScore(score)) throw new Error('Oracle returned an invalid score');
  return score;
}

export async function getScore(
  destination: string,
  options?: { timeoutMs?: number; signal?: AbortSignal; bypassCache?: boolean },
): Promise<number> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_GET_SCORE_TIMEOUT_MS;
  const bypassCache = options?.bypassCache ?? false;

  if (!bypassCache) {
    const cached = scoreCache.get(destination);
    if (cached !== undefined) return cached;
  }

  const existing = inFlightScores.get(destination);
  if (existing) return await existing;

  const controller = new AbortController();
  const combinedSignal = options?.signal
    ? ('any' in AbortSignal ? AbortSignal.any([options.signal, controller.signal]) : options.signal)
    : controller.signal;

  const request = circuitBreaker.exec(async () => {
    const score = await retryWithBackoff(
      async (signal) => fetchScore(destination, { signal }),
      2,
      200,
      combinedSignal,
    );
    if (!isValidScore(score)) throw new Error('Oracle returned an invalid score');
    scoreCache.set(destination, score);
    return score;
  }, -1).catch((error) => {
    if (combinedSignal.aborted || options?.signal?.aborted) throw error;
    return -1;
  });

  inFlightScores.set(destination, request);

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      const id = setTimeout(() => {
        controller.abort();
        reject(new DOMException('Timeout', 'TimeoutError'));
      }, timeoutMs);
      combinedSignal.addEventListener('abort', () => clearTimeout(id), { once: true });
    });

    return await Promise.race([request, timeoutPromise]);
  } catch {
    return -1;
  } finally {
    inFlightScores.delete(destination);
  }
}

function stubScoreFor(destination: string): number {
  let hash = 0;
  for (let i = 0; i < destination.length; i++) {
    hash = (hash * 31 + destination.charCodeAt(i)) >>> 0;
  }
  return hash % 101;
}
