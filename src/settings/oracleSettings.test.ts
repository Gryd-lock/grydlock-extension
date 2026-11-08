import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ORACLE_SETTINGS,
  MAINNET_PASSPHRASE,
  ORACLE_SETTINGS_KEY,
  TESTNET_PASSPHRASE,
  effectiveOracleSettings,
  isValidRpcUrl,
  loadOracleSettings,
  parseOracleSettings,
  saveOracleSettings,
  validateOracleSettings,
} from './oracleSettings'

const CONTRACT = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE'

describe('validateOracleSettings', () => {
  it('accepts a trimmed contract id and https RPC', () => {
    expect(
      validateOracleSettings({ source: 'soroban', contractId: ` ${CONTRACT} `, rpcUrl: 'https://rpc.example ' }),
    ).toEqual({ ok: true, settings: { source: 'soroban', contractId: CONTRACT, rpcUrl: 'https://rpc.example' } })
  })

  it('rejects account ids and malformed contract ids', () => {
    expect(
      validateOracleSettings({
        source: 'soroban',
        contractId: 'GCRNKXJJLZNDLK2EWPX25JISTORCXCF2HYUXMYKF7XWKHMEOHCXVGP4J',
        rpcUrl: 'https://rpc.example',
      }),
    ).toEqual({ ok: false, error: 'invalid-contract-id' })
    expect(
      validateOracleSettings({ source: 'soroban', contractId: 'CNOPE', rpcUrl: 'https://rpc.example' }),
    ).toEqual({ ok: false, error: 'invalid-contract-id' })
  })

  it.each([
    ['https://soroban-testnet.stellar.org', true],
    ['http://localhost:8000/soroban/rpc', true],
    ['http://rpc.example', false],
    ['https://user:pass@rpc.example', false],
    ['javascript:alert(1)', false],
    ['not a url', false],
  ])('RPC URL %s valid=%s', (url, valid) => {
    expect(isValidRpcUrl(url)).toBe(valid)
  })
})

describe('parseOracleSettings', () => {
  it.each([undefined, null, 'soroban', {}, { source: 'bogus' }, { source: 'soroban', contractId: 'x', rpcUrl: 'https://a' }])(
    'fails closed to off for %j',
    (raw) => {
      expect(parseOracleSettings(raw)).toEqual(DEFAULT_ORACLE_SETTINGS)
    },
  )

  it('round-trips valid settings', () => {
    expect(parseOracleSettings({ source: 'testkit-fixtures' })).toEqual({ source: 'testkit-fixtures' })
  })
})

describe('effectiveOracleSettings', () => {
  it('allows fixtures on testnet', () => {
    expect(effectiveOracleSettings({ source: 'testkit-fixtures' }, TESTNET_PASSPHRASE)).toEqual({
      settings: { source: 'testkit-fixtures' },
    })
  })

  it.each([MAINNET_PASSPHRASE, 'Test SDF Future Network ; October 2022', undefined])(
    'refuses fixtures on %s',
    (passphrase) => {
      expect(effectiveOracleSettings({ source: 'testkit-fixtures' }, passphrase)).toEqual({
        settings: { source: 'off' },
        refusal: 'fixtures-require-testnet',
      })
    },
  )

  it('leaves the soroban source to the network check inside SorobanOracle', () => {
    const settings = { source: 'soroban' as const, contractId: CONTRACT, rpcUrl: 'https://a.example' }
    expect(effectiveOracleSettings(settings, MAINNET_PASSPHRASE)).toEqual({ settings })
  })
})

describe('storage', () => {
  const original = globalThis.chrome
  afterEach(() => {
    globalThis.chrome = original
  })

  it('loads, validates and saves under the versioned key', async () => {
    const store: Record<string, unknown> = {}
    globalThis.chrome = {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: store[key] })),
          set: vi.fn(async (items: Record<string, unknown>) => Object.assign(store, items)),
        },
      },
    } as unknown as typeof chrome
    expect(await loadOracleSettings()).toEqual({ source: 'off' })
    await saveOracleSettings({ source: 'testkit-fixtures' })
    expect(store[ORACLE_SETTINGS_KEY]).toEqual({ source: 'testkit-fixtures' })
    expect(await loadOracleSettings()).toEqual({ source: 'testkit-fixtures' })
    await expect(
      saveOracleSettings({ source: 'soroban', contractId: 'bad', rpcUrl: 'https://a' }),
    ).rejects.toThrow('invalid-contract-id')
  })
})
