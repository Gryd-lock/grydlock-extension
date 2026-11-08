import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import OracleSettingsPanel from './OracleSettingsPanel'
import { ORACLE_SETTINGS_KEY } from './oracleSettings'

describe('OracleSettingsPanel', () => {
  const original = globalThis.chrome
  let store: Record<string, unknown>

  beforeEach(() => {
    store = {}
    globalThis.chrome = {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: store[key] })),
          set: vi.fn(async (items: Record<string, unknown>) => Object.assign(store, items)),
        },
      },
    } as unknown as typeof chrome
  })

  afterEach(() => {
    globalThis.chrome = original
  })

  it('defaults to Off', async () => {
    render(<OracleSettingsPanel />)
    expect(await screen.findByLabelText(/off \(default\)/i)).toBeChecked()
  })

  it('saves testkit fixture mode and explains it is testnet only', async () => {
    render(<OracleSettingsPanel />)
    fireEvent.click(await screen.findByLabelText(/testkit fixtures \(testnet only\)/i))
    expect(screen.getByText(/ignored for any request that is not on the stellar testnet/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/saved/i)
    expect(store[ORACLE_SETTINGS_KEY]).toEqual({ source: 'testkit-fixtures' })
  })

  it('refuses to save an invalid Soroban contract id', async () => {
    render(<OracleSettingsPanel />)
    fireEvent.click(await screen.findByLabelText(/soroban oracle/i))
    fireEvent.change(screen.getByLabelText('Contract ID'), { target: { value: 'GNOTACONTRACT' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/valid soroban contract id/i)
    expect(store[ORACLE_SETTINGS_KEY]).toBeUndefined()
  })

  it('saves a valid Soroban configuration', async () => {
    const contractId = 'CAEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQTD2L'
    render(<OracleSettingsPanel />)
    fireEvent.click(await screen.findByLabelText(/soroban oracle/i))
    fireEvent.change(screen.getByLabelText('Contract ID'), { target: { value: contractId } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/saved/i)
    expect(store[ORACLE_SETTINGS_KEY]).toEqual({
      source: 'soroban',
      contractId,
      rpcUrl: 'https://soroban-testnet.stellar.org',
    })
  })
})
