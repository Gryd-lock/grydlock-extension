import { describe, expect, it, vi } from 'vitest'
import { resolveOutcome } from './resolveOutcome'

describe('resolveOutcome', () => {
  it('returns allow when no destination can be determined', async () => {
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

  it('scores the destination and returns the requested decision, forwarding networkPassphrase', async () => {
    const extractDestination = vi.fn().mockReturnValue({ destination: 'GDEST', asset: 'USD:GISSUER' })
    const getScore = vi.fn().mockResolvedValue(42)
    const requestDecision = vi.fn().mockResolvedValue('proceed')

    const outcome = await resolveOutcome(
      'some-xdr',
      {
        extractDestination,
        getScore,
        requestDecision,
      },
      'Public Global Stellar Network ; September 2015',
    )

    expect(extractDestination).toHaveBeenCalledWith('some-xdr', 'Public Global Stellar Network ; September 2015')
    expect(getScore).toHaveBeenCalledWith('GDEST')
    expect(requestDecision).toHaveBeenCalledWith({ destination: 'GDEST', asset: 'USD:GISSUER', score: 42 })
    expect(outcome).toBe('proceed')
  })

  it('returns cancel when the user cancels', async () => {
    const outcome = await resolveOutcome('some-xdr', {
      extractDestination: () => ({ destination: 'GDEST' }),
      getScore: async () => 90,
      requestDecision: async () => 'cancel',
    })

    expect(outcome).toBe('cancel')
  })
})
