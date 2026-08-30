import { describe, expect, it, vi } from 'vitest'
import { resolveOutcome, resolveReviewOutcome } from './resolveOutcome'

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
    const getScore = vi.fn().mockResolvedValueOnce(10).mockResolvedValueOnce(90)
    const requestDecision = vi.fn().mockResolvedValue('proceed')

    const outcome = await resolveOutcome('some-xdr', {
      extractDestination: () => ({
        destinations: [
          { destination: 'GLOW', asset: 'USD:GISS' },
          { destination: 'GHIGH', asset: undefined },
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
      extractDestination: () => ({ destinations: [{ destination: 'GONE' }] }),
      getScore: async () => 20,
      requestDecision: async () => 'cancel',
    })

    expect(outcome).toBe('cancel')
  })

  describe('oracle failure', () => {
    it('calls requestDecision with an invalid score when getScore rejects so it is never low risk', async () => {
      const requestDecision = vi.fn().mockResolvedValue('cancel')

      await resolveOutcome('some-xdr', {
        extractDestination: () => ({
          destinations: [{ destination: 'GDEST', asset: 'USD:GISSUER' }],
        }),
        getScore: vi.fn().mockRejectedValue(new Error('network timeout')),
        requestDecision,
      })

      expect(requestDecision).toHaveBeenCalledWith({
        destinations: [{ destination: 'GDEST', asset: 'USD:GISSUER' }],
        scores: [{ destination: 'GDEST', asset: 'USD:GISSUER', score: Number.NaN }],
        worstScore: Number.NaN,
      })
    })

    it('does NOT return allow when oracle fails — unscored is not the same as no-destination allow', async () => {
      const requestDecision = vi.fn().mockResolvedValue('cancel')

      const outcome = await resolveOutcome('some-xdr', {
        extractDestination: () => ({ destinations: [{ destination: 'GDEST' }] }),
        getScore: vi.fn().mockRejectedValue(new Error('oracle down')),
        requestDecision,
      })

      // resolveOutcome must not silently allow; it must defer to requestDecision
      expect(outcome).not.toBe('allow')
      expect(requestDecision).toHaveBeenCalledTimes(1)
    })

    it('propagates the user proceed decision even when oracle failed', async () => {
      const outcome = await resolveOutcome('some-xdr', {
        extractDestination: () => ({ destinations: [{ destination: 'GDEST' }] }),
        getScore: vi.fn().mockRejectedValue(new Error('oracle down')),
        requestDecision: async () => 'proceed',
      })

      expect(outcome).toBe('proceed')
    })

    it('propagates the user cancel decision when oracle failed', async () => {
      const outcome = await resolveOutcome('some-xdr', {
        extractDestination: () => ({ destinations: [{ destination: 'GDEST' }] }),
        getScore: vi.fn().mockRejectedValue(new Error('oracle down')),
        requestDecision: async () => 'cancel',
      })

      expect(outcome).toBe('cancel')
    })
  })
})

describe('resolveReviewOutcome', () => {
  const opaqueReview = {
    schemaVersion: 1 as const,
    policyVersion: 1 as const,
    networkPassphrase: 'Custom Network',
    xdrDigest: 'a'.repeat(64),
    envelope: { type: 'transaction' as const, source: 'GSOURCE', operationCount: 1 },
    memo: undefined,
    operations: [
      {
        index: 0,
        type: 'futureOperation',
        source: 'GSOURCE',
        coverage: 'opaque' as const,
        summary: 'Unknown',
        facts: [],
        targets: [],
        findings: [],
      },
    ],
    findings: [],
  }

  it('fails closed for malformed XDR rather than allowing it as green', async () => {
    await expect(
      resolveReviewOutcome('bad', {
        extractReview: () => null,
        getScore: vi.fn(),
        requestDecision: vi.fn(),
      }),
    ).resolves.toBe('cancel')
  })

  it('sends opaque operations to review with an incomplete-coverage finding', async () => {
    const requestDecision = vi.fn().mockResolvedValue('proceed')
    await expect(
      resolveReviewOutcome('xdr', {
        extractReview: () => opaqueReview,
        getScore: vi.fn(),
        requestDecision,
      }),
    ).resolves.toBe('proceed')
    expect(requestDecision.mock.calls[0][0]).toMatchObject({ severity: 'warning' })
    expect(requestDecision.mock.calls[0][0].findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'incomplete-coverage' })]),
    )
  })

  it('queries account targets but never claimable-balance targets', async () => {
    const review = {
      ...opaqueReview,
      operations: [
        {
          ...opaqueReview.operations[0],
          coverage: 'partial' as const,
          targets: [
            { type: 'account' as const, value: 'GACCOUNT', networkPassphrase: 'Custom Network' },
            {
              type: 'claimable-balance' as const,
              value: 'balance-id',
              networkPassphrase: 'Custom Network',
            },
          ],
        },
      ],
    }
    const getScore = vi.fn().mockResolvedValue(5)
    await resolveReviewOutcome('xdr', {
      extractReview: () => review,
      getScore,
      requestDecision: async () => 'cancel',
    })
    expect(getScore).toHaveBeenCalledTimes(1)
    expect(getScore).toHaveBeenCalledWith({
      type: 'account',
      value: 'GACCOUNT',
      networkPassphrase: 'Custom Network',
    })
  })
})
