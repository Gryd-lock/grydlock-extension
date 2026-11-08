import { isValidStrKey } from 'grydlock-oracle-adapter'

/**
 * User-selected destination score source. Stored in chrome.storage.local
 * under {@link ORACLE_SETTINGS_KEY}. Anything unreadable resolves to `off`.
 */
export type OracleSettings =
  | { source: 'off' }
  | { source: 'testkit-fixtures' }
  | { source: 'soroban'; contractId: string; rpcUrl: string }

export const ORACLE_SETTINGS_KEY = 'oracleSettingsV1'
export const DEFAULT_ORACLE_SETTINGS: OracleSettings = { source: 'off' }
export const DEFAULT_TESTNET_RPC_URL = 'https://soroban-testnet.stellar.org'

export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015'
export const MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015'

export type OracleSettingsError = 'invalid-contract-id' | 'invalid-rpc-url'

export function isValidContractId(value: string): boolean {
  return isValidStrKey(value.trim(), 'contract')
}

/** HTTPS only, except plain-HTTP loopback for a local RPC during development. */
export function isValidRpcUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    if (url.username || url.password) return false
    if (url.protocol === 'https:') return true
    return (
      url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
  } catch {
    return false
  }
}

/** Validates user input; returns the normalized settings or the first error. */
export function validateOracleSettings(
  input: OracleSettings,
): { ok: true; settings: OracleSettings } | { ok: false; error: OracleSettingsError } {
  if (input.source !== 'soroban') return { ok: true, settings: { source: input.source } }
  const contractId = input.contractId.trim()
  const rpcUrl = input.rpcUrl.trim()
  if (!isValidContractId(contractId)) return { ok: false, error: 'invalid-contract-id' }
  if (!isValidRpcUrl(rpcUrl)) return { ok: false, error: 'invalid-rpc-url' }
  return { ok: true, settings: { source: 'soroban', contractId, rpcUrl } }
}

/** Parses untrusted stored data. Fails closed to `off`, never to a score source. */
export function parseOracleSettings(raw: unknown): OracleSettings {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_ORACLE_SETTINGS
  const value = raw as Record<string, unknown>
  if (value.source === 'testkit-fixtures') return { source: 'testkit-fixtures' }
  if (
    value.source === 'soroban' &&
    typeof value.contractId === 'string' &&
    typeof value.rpcUrl === 'string'
  ) {
    const result = validateOracleSettings({
      source: 'soroban',
      contractId: value.contractId,
      rpcUrl: value.rpcUrl,
    })
    return result.ok ? result.settings : DEFAULT_ORACLE_SETTINGS
  }
  return DEFAULT_ORACLE_SETTINGS
}

export async function loadOracleSettings(): Promise<OracleSettings> {
  if (!globalThis.chrome?.storage?.local) return DEFAULT_ORACLE_SETTINGS
  try {
    const stored = await chrome.storage.local.get(ORACLE_SETTINGS_KEY)
    return parseOracleSettings(stored[ORACLE_SETTINGS_KEY])
  } catch {
    return DEFAULT_ORACLE_SETTINGS
  }
}

export async function saveOracleSettings(settings: OracleSettings): Promise<OracleSettings> {
  const result = validateOracleSettings(settings)
  if (!result.ok) throw new Error(result.error)
  await chrome.storage.local.set({ [ORACLE_SETTINGS_KEY]: result.settings })
  return result.settings
}

/** Why a configured source was not used for a particular request. */
export type OracleSourceRefusal = 'fixtures-require-testnet'

/**
 * Applies network policy to the stored settings for one signing request.
 * Testkit fixtures are synthetic testnet addresses: they are refused on
 * mainnet (and on any non-testnet passphrase) so a fixture score can never
 * be shown for a real-funds transaction.
 */
export function effectiveOracleSettings(
  settings: OracleSettings,
  networkPassphrase: string | undefined,
): { settings: OracleSettings; refusal?: OracleSourceRefusal } {
  if (settings.source === 'testkit-fixtures' && networkPassphrase !== TESTNET_PASSPHRASE) {
    return { settings: DEFAULT_ORACLE_SETTINGS, refusal: 'fixtures-require-testnet' }
  }
  return { settings }
}
