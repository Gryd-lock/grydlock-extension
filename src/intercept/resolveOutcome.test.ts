import { describe, expect, it, vi } from 'vitest'
import { resolveOutcome } from './resolveOutcome'

describe('resolveOutcome', () => {
  it('returns allow when no destinations can be determined', async () => {
    const getScore = vi.fn()
    const requestDecision = vi.fn()

    const outcome = await resolveOutcome('some-xdr', {
      extractDestination: () => null,
      getScore,
      requestDecision,
    })

    expect(outcome).toBe('allow')
    expect(getScore).not.toHaveBeenCalled()
    expect(requestDecision).not.toHaveBeenCalled()
  })

  it('scores each destination and surfaces the worst tier to the popup', async () => {
    const getScore = vi.fn()
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(90)
    const requestDecision = vi.fn().mockResolvedValue('proceed')

    const outcome = await resolveOutcome('some-xdr', {
      extractDestination: () => ({
        destinations: [
          { destination: 'GLOW', asset: 'USD:GISS', score: 10 },
          { destination: 'GHIGH', asset: undefined, score: 90 },
        ],
      }),
      getScore,
      requestDecision,
    })

    expect(outcome).toBe('proceed')
    expect(getScore).toHaveBeenCalledTimes(2)
    expect(requestDecision).toHaveBeenCalledWith({
      destinations: [
        { destination: 'GLOW', asset: 'USD:GISS' },
        { destination: 'GHIGH', asset: undefined },
      ],
      scores: [
        { destination: 'GLOW', asset: 'USD:GISS', score: 10 },
        { destination: 'GHIGH', score: 90 },
      ],
      worstScore: 90,
    })
  })

  it('returns cancel when the user cancels', async () => {
    const outcome = await resolveOutcome('some-xdr', {
      extractDestination: () => ({ destinations: [{ destination: 'GONE', score: 20 }] }),
      getScore: async () => 20,
      requestDecision: async () => 'cancel',
    })

    expect(outcome).toBe('cancel')
  })
})
