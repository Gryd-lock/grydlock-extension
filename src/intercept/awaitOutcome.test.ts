import { describe, expect, it, vi } from 'vitest'
import { awaitOutcome, type AwaitOutcomeResponse } from './awaitOutcome'

// A fake clock/sleep pair: `sleep` advances the fake clock by exactly the
// requested amount instead of waiting on a real timer, per the CI guidance
// to keep non-deterministic/timing-sensitive tests off real timers.
function fakeClock(startAt: number) {
  let now = startAt
  return {
    now: () => now,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        now += ms
        resolve()
      }),
  }
}

describe('awaitOutcome', () => {
  it('returns the outcome from the first matching SIGN_OUTCOME response', async () => {
    const clock = fakeClock(0)
    const sendMessage = vi.fn(
      async (): Promise<AwaitOutcomeResponse> => ({
        type: 'SIGN_OUTCOME',
        requestId: 'req-1',
        outcome: 'proceed',
      }),
    )

    const outcome = await awaitOutcome('req-1', 10_000, {
      sendMessage,
      now: clock.now,
      sleep: clock.sleep,
    })

    expect(outcome).toBe('proceed')
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith('req-1')
  })

  it('retries on a disconnected/undefined response (simulating a dead or restarting worker), then resolves once it reconnects', async () => {
    const clock = fakeClock(0)
    const sendMessage = vi
      .fn<(id: string) => Promise<AwaitOutcomeResponse | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ type: 'SIGN_OUTCOME', requestId: 'req-1', outcome: 'cancel' })

    const outcome = await awaitOutcome('req-1', 60_000, {
      sendMessage,
      now: clock.now,
      sleep: clock.sleep,
    })

    expect(outcome).toBe('cancel')
    expect(sendMessage).toHaveBeenCalledTimes(3)
  })

  it('ignores a response for a different requestId (defense in depth) and keeps retrying', async () => {
    const clock = fakeClock(0)
    const sendMessage = vi
      .fn<(id: string) => Promise<AwaitOutcomeResponse | undefined>>()
      .mockResolvedValueOnce({ type: 'SIGN_OUTCOME', requestId: 'someone-elses-request', outcome: 'proceed' })
      .mockResolvedValueOnce({ type: 'SIGN_OUTCOME', requestId: 'req-1', outcome: 'proceed' })

    const outcome = await awaitOutcome('req-1', 60_000, {
      sendMessage,
      now: clock.now,
      sleep: clock.sleep,
    })

    expect(outcome).toBe('proceed')
    expect(sendMessage).toHaveBeenCalledTimes(2)
  })

  it('resolves cancel once the absolute deadline passes without ever needing the background to answer', async () => {
    const clock = fakeClock(0)
    const sendMessage = vi.fn(async (): Promise<AwaitOutcomeResponse | undefined> => undefined)

    const outcome = await awaitOutcome('req-1', 1_000, {
      sendMessage,
      now: clock.now,
      sleep: clock.sleep,
      backoffMs: () => 400,
    })

    expect(outcome).toBe('cancel')
    // Deadline is enforced without depending on the background ever responding.
    expect(sendMessage.mock.calls.length).toBeGreaterThan(0)
    expect(clock.now()).toBeGreaterThanOrEqual(1_000)
  })

  it('never calls sendMessage once the deadline has already passed', async () => {
    const clock = fakeClock(5_000)
    const sendMessage = vi.fn()

    const outcome = await awaitOutcome('req-1', 1_000, {
      sendMessage,
      now: clock.now,
      sleep: clock.sleep,
    })

    expect(outcome).toBe('cancel')
    expect(sendMessage).not.toHaveBeenCalled()
  })
})
