import { describe, expect, it, vi } from 'vitest'
import { getScore } from './oracleAdapter'

describe('getScore', () => {
  it('resolves a score between 0 and 100', async () => {
    const score = await getScore('GDESTINATIONPLACEHOLDER')
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(100)
  })

  it('is deterministic for the same destination', async () => {
    const a = await getScore('SAME')
    const b = await getScore('SAME')
    expect(a).toBe(b)
  })

  it('returns fallback -1 on timeout', async () => {
    vi.useFakeTimers();
    const promise = getScore('TIMEOUTDEST', { timeoutMs: 50 });
    // advance timers past the internal delay (150ms) and timeout (50ms)
    vi.advanceTimersByTime(200);
    const result = await promise;
    expect(result).toBe(-1);
    vi.useRealTimers();
  });
});
