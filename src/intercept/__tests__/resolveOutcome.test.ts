import { describe, expect, it, vi } from 'vitest'
import { resolveOutcome } from '../resolveOutcome'

describe('resolveOutcome batch compatibility', () => {
  it('requests a decision for an untrusted destination', async () => {
    const requestDecision = vi.fn().mockResolvedValue('proceed')

    const outcome = await resolveOutcome('dummyXDR', {
      extractDestination: () => ({ destinations: [{ destination: 'GDEST' }] }),
      getScore: vi.fn().mockResolvedValue(42),
      requestDecision,
    })

    expect(outcome).toBe('proceed')
    expect(requestDecision).toHaveBeenCalledWith({
      destinations: [{ destination: 'GDEST' }],
      scores: [{ destination: 'GDEST', asset: undefined, score: 42 }],
      worstScore: 42,
    })
  })
})
