import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import History from './History'
import { HISTORY_KEY } from '../lib/history'

describe('History', () => {
  const originalChrome = globalThis.chrome
  const get = vi.fn()
  const remove = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    remove.mockResolvedValue(undefined)
    // @ts-expect-error test-only stub of the chrome extension API
    globalThis.chrome = { storage: { local: { get, remove } } }
  })

  afterEach(() => {
    globalThis.chrome = originalChrome
  })

  it('shows an empty state when no decisions are stored', async () => {
    get.mockResolvedValue({})
    render(<History />)
    expect(await screen.findByText(/no decisions recorded yet/i)).toBeInTheDocument()
  })

  it('lists stored decisions with tier and decision labels', async () => {
    get.mockResolvedValue({
      [HISTORY_KEY]: [
        {
          destination: 'GDEST',
          asset: 'USDC',
          score: 85,
          tier: 'critical',
          decision: 'cancel',
          timestamp: 1700000000000,
        },
        {
          destination: 'GSAFE',
          score: 10,
          tier: 'low',
          decision: 'proceed',
          timestamp: 1700000100000,
        },
      ],
    })
    render(<History />)
    expect(await screen.findByText('GDEST')).toBeInTheDocument()
    expect(screen.getByText('USDC')).toBeInTheDocument()
    expect(screen.getByText('Cancelled')).toBeInTheDocument()
    expect(screen.getByText('GSAFE')).toBeInTheDocument()
    expect(screen.getByText('Proceeded')).toBeInTheDocument()
    expect(screen.getByText(/critical/i)).toBeInTheDocument()
  })

  it('shows an error state when storage reads fail', async () => {
    get.mockRejectedValue(new Error('storage broken'))
    render(<History />)
    expect(await screen.findByText(/could not read history/i)).toBeInTheDocument()
  })

  it('clears history and shows the empty state', async () => {
    get.mockResolvedValue({
      [HISTORY_KEY]: [
        {
          destination: 'GDEST',
          score: 85,
          tier: 'critical',
          decision: 'cancel',
          timestamp: 1700000000000,
        },
      ],
    })
    render(<History />)
    fireEvent.click(await screen.findByText(/clear history/i))
    expect(await screen.findByText(/no decisions recorded yet/i)).toBeInTheDocument()
    expect(remove).toHaveBeenCalledWith(HISTORY_KEY)
  })
})
