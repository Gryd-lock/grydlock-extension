import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TrustedAddressesManager from './TrustedAddressesManager'
import * as storage from '../utils/storageHelper'

describe('TrustedAddressesManager', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('shows an empty state when no trusted addresses exist', async () => {
    vi.spyOn(storage, 'getTrustedAddresses').mockResolvedValue([])
    render(<TrustedAddressesManager onClose={vi.fn()} />)
    expect(await screen.findByText(/no trusted addresses/i)).toBeInTheDocument()
  })

  it('renders stored addresses and closes on request', async () => {
    const onClose = vi.fn()
    vi.spyOn(storage, 'getTrustedAddresses').mockResolvedValue(['GDEST'])

    render(<TrustedAddressesManager onClose={onClose} />)
    expect(await screen.findByText('GDEST')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('removes an address and refreshes the list', async () => {
    const getTrustedAddresses = vi
      .spyOn(storage, 'getTrustedAddresses')
      .mockResolvedValueOnce(['GREMOVE'])
      .mockResolvedValueOnce([])
    const removeTrustedAddress = vi.spyOn(storage, 'removeTrustedAddress').mockResolvedValue()

    render(<TrustedAddressesManager onClose={vi.fn()} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }))

    expect(removeTrustedAddress).toHaveBeenCalledWith('GREMOVE')
    expect(getTrustedAddresses).toHaveBeenCalledTimes(2)
    expect(await screen.findByText(/no trusted addresses/i)).toBeInTheDocument()
  })
})
