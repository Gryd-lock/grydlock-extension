import { useEffect, useId, useState, type FormEvent } from 'react'
import {
  DEFAULT_TESTNET_RPC_URL,
  loadOracleSettings,
  saveOracleSettings,
  validateOracleSettings,
  type OracleSettings,
  type OracleSettingsError,
} from './oracleSettings'

type Source = OracleSettings['source']

const ERROR_TEXT: Record<OracleSettingsError, string> = {
  'invalid-contract-id': 'Enter a valid Soroban contract ID (starts with C, 56 characters).',
  'invalid-rpc-url': 'Enter an https:// RPC URL (plain http is only allowed for localhost).',
}

export default function OracleSettingsPanel() {
  const headingId = useId()
  const [loaded, setLoaded] = useState(false)
  const [source, setSource] = useState<Source>('off')
  const [contractId, setContractId] = useState('')
  const [rpcUrl, setRpcUrl] = useState(DEFAULT_TESTNET_RPC_URL)
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadOracleSettings().then((settings) => {
      if (cancelled) return
      setSource(settings.source)
      if (settings.source === 'soroban') {
        setContractId(settings.contractId)
        setRpcUrl(settings.rpcUrl)
      }
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function onSave(event: FormEvent) {
    event.preventDefault()
    const candidate: OracleSettings =
      source === 'soroban' ? { source, contractId, rpcUrl } : { source }
    const result = validateOracleSettings(candidate)
    if (!result.ok) {
      setStatus({ kind: 'error', text: ERROR_TEXT[result.error] })
      return
    }
    try {
      await saveOracleSettings(result.settings)
      setStatus({ kind: 'saved', text: 'Saved. Applies to the next signing request.' })
    } catch {
      setStatus({ kind: 'error', text: 'Could not save settings.' })
    }
  }

  return (
    <section aria-labelledby={headingId} className="oracle-settings">
      <h2 id={headingId}>Destination risk score source</h2>
      <p className="privacy-note">
        The transaction review always runs locally. A score source only adds a 0–100 destination
        score. With &ldquo;Off&rdquo;, destinations are shown as unscored, never as low risk.
      </p>
      <form onSubmit={onSave} aria-busy={!loaded}>
        <fieldset disabled={!loaded}>
          <legend>Score source</legend>
          <label>
            <input
              type="radio"
              name="oracle-source"
              value="off"
              checked={source === 'off'}
              onChange={() => setSource('off')}
            />{' '}
            Off (default)
          </label>
          <label>
            <input
              type="radio"
              name="oracle-source"
              value="testkit-fixtures"
              checked={source === 'testkit-fixtures'}
              onChange={() => setSource('testkit-fixtures')}
            />{' '}
            Testkit fixtures (testnet only)
          </label>
          {source === 'testkit-fixtures' && (
            <p className="privacy-note">
              Synthetic scores for grydlock-testkit addresses. Ignored for any request that is not
              on the Stellar testnet passphrase, including mainnet.
            </p>
          )}
          <label>
            <input
              type="radio"
              name="oracle-source"
              value="soroban"
              checked={source === 'soroban'}
              onChange={() => setSource('soroban')}
            />{' '}
            Soroban oracle (contract ID) — experimental
          </label>
          {source === 'soroban' && (
            <div className="soroban-fields">
              <label>
                Contract ID
                <input
                  type="text"
                  value={contractId}
                  onChange={(event) => setContractId(event.target.value)}
                  placeholder="C…"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <label>
                RPC URL
                <input
                  type="url"
                  value={rpcUrl}
                  onChange={(event) => setRpcUrl(event.target.value)}
                  spellCheck={false}
                />
              </label>
              <p className="privacy-note">
                Each scored destination address is sent to this RPC node in a read-only simulation.
                No Gryd Lock oracle contract is deployed yet; until one is, lookups report
                &ldquo;assessment unavailable&rdquo;.
              </p>
            </div>
          )}
        </fieldset>
        <button type="submit" disabled={!loaded}>
          Save
        </button>
        {status && (
          <p role={status.kind === 'error' ? 'alert' : 'status'} className={status.kind}>
            {status.text}
          </p>
        )}
      </form>
    </section>
  )
}
