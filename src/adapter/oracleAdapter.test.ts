import { describe, expect, it } from 'vitest'
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
})
