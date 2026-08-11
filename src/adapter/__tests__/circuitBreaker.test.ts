import { describe, expect, it, vi } from 'vitest'
import { CircuitBreaker } from '../oracleAdapter'

describe('CircuitBreaker', () => {
  it('returns fallback while open', async () => {
    const breaker = new CircuitBreaker(1, 1_000, 10_000)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(breaker.exec(async () => {
      throw new Error('boom')
    }, -1)).rejects.toThrow('boom')

    const fallback = await breaker.exec(async () => 42, -1)
    expect(fallback).toBe(-1)
    warn.mockRestore()
  })

  it('moves half-open back to closed after cooldown success', async () => {
    vi.useFakeTimers()
    const breaker = new CircuitBreaker(1, 1_000, 10_000)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(breaker.exec(async () => {
      throw new Error('boom')
    }, -1)).rejects.toThrow('boom')

    vi.advanceTimersByTime(10_001)
    await expect(breaker.exec(async () => 42, -1)).resolves.toBe(42)
    expect(warn).toHaveBeenCalledWith('Circuit breaker half‑open')
    expect(warn).toHaveBeenCalledWith('Circuit breaker closed')

    vi.useRealTimers()
    warn.mockRestore()
  })
})
