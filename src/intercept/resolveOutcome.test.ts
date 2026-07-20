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

  describe('oracle failure', () => {
    it('calls requestDecision with score=null when getScore rejects', async () => {
      const requestDecision = vi.fn().mockResolvedValue('cancel')

      await resolveOutcome('some-xdr', {
        extractDestination: () => ({ destination: 'GDEST', asset: 'USD:GISSUER' }),
        getScore: vi.fn().mockRejectedValue(new Error('network timeout')),
        requestDecision,
      })

      // Must reach requestDecision (not hang or throw) and pass null score
      expect(requestDecision).toHaveBeenCalledWith({
        destination: 'GDEST',
        asset: 'USD:GISSUER',
        score: null,
      })
    })

    it('does NOT return allow when oracle fails — unscored is not the same as no-destination allow', async () => {
      const requestDecision = vi.fn().mockResolvedValue('cancel')

      const outcome = await resolveOutcome('some-xdr', {
        extractDestination: () => ({ destination: 'GDEST' }),
        getScore: vi.fn().mockRejectedValue(new Error('oracle down')),
        requestDecision,
      })

      // resolveOutcome must not silently allow; it must defer to requestDecision
      expect(outcome).not.toBe('allow')
      expect(requestDecision).toHaveBeenCalledTimes(1)
    })

    it('propagates the user proceed decision even when oracle failed', async () => {
      const outcome = await resolveOutcome('some-xdr', {
        extractDestination: () => ({ destination: 'GDEST' }),
        getScore: vi.fn().mockRejectedValue(new Error('oracle down')),
        requestDecision: async () => 'proceed',
      })

      expect(outcome).toBe('proceed')
    })

    it('propagates the user cancel decision when oracle failed', async () => {
      const outcome = await resolveOutcome('some-xdr', {
        extractDestination: () => ({ destination: 'GDEST' }),
        getScore: vi.fn().mockRejectedValue(new Error('oracle down')),
        requestDecision: async () => 'cancel',
      })

      expect(outcome).toBe('cancel')
    })
  })
})

