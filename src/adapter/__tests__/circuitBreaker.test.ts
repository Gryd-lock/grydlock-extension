import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { circuitBreaker as _circuitBreaker } from '../oracleAdapter'; // We'll import via path alias? Actually circuitBreaker is not exported. We'll re-export for test purposes.

// To expose circuit breaker for testing, we temporarily add an export in oracleAdapter.
// This test will mock fetchScore to simulate failures.

import { getScore, fetchScore } from '../oracleAdapter';

// Helper to replace the internal circuitBreaker with a fresh instance for isolation
function createBreaker() {
  // @ts-ignore – accessing private class via import side‑effect
  const { CircuitBreaker } = require('../oracleAdapter');
  return new CircuitBreaker(2, 1000, 500); // 2 failures, 1s window, 0.5s cooldown
}

describe('CircuitBreaker behavior in getScore', () => {
  let originalFetch: typeof fetchScore;

  beforeEach(() => {
    originalFetch = fetchScore;
  });

  afterEach(() => {
    // restore original implementation
    (fetchScore as any) = originalFetch;
    vi.restoreAllMocks();
  });

  it('retries on transient error and eventually succeeds', async () => {
    let callCount = 0;
    (fetchScore as any) = vi.fn(async (dest: string) => {
      callCount++;
      if (callCount === 1) throw new Error('Transient');
      return 42;
    });
    const score = await getScore('dest1', { timeoutMs: 1000 });
    expect(score).toBe(42);
    expect(callCount).toBe(2); // one retry
  });

  it('opens circuit after consecutive failures and returns fallback', async () => {
    // Force fetchScore to always fail
    (fetchScore as any) = vi.fn(() => Promise.reject(new Error('Always fail')));

    // First call – should attempt, fail, retry, fail, then fallback -1 via breaker open
    const score1 = await getScore('dest2', { timeoutMs: 1000 });
    expect(score1).toBe(-1);

    // Second call within cooldown – circuit is open, should return fallback immediately without calling fetchScore
    const spy = vi.spyOn(console, 'warn');
    const score2 = await getScore('dest2', { timeoutMs: 1000 });
    expect(score2).toBe(-1);
    expect(fetchScore).toHaveBeenCalledTimes(0);
    // console.warn should not be called for timeout path because breaker short‑circuits
    expect(spy).not.toHaveBeenCalled();
  });
});
