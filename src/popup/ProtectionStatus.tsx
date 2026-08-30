import { useEffect, useState } from 'react'
import type { ProtectionSnapshot, ProtectionStatus } from '../protection/protectionState'

const STATUS_COPY: Record<ProtectionStatus, { title: string; detail: string }> = {
  protected: {
    title: 'Protection path checked',
    detail:
      'The extension recently completed a non-financial check from this page through its bridge and worker. Browser extension listener ordering remains outside the extension’s control.',
  },
  stale: {
    title: 'Protection check is stale',
    detail: 'Reload this page and wait for a new check before relying on Gryd Lock protection.',
  },
  'bridge-unavailable': {
    title: 'Bridge unavailable',
    detail:
      'This page has not reached Gryd Lock’s isolated bridge. Do not assume signing requests are reviewed.',
  },
  'worker-unavailable': {
    title: 'Worker status unavailable',
    detail:
      'Gryd Lock could not obtain a current protection result. Do not assume signing requests are reviewed.',
  },
  'permission-denied': {
    title: 'Site access is disabled',
    detail:
      'Restore Gryd Lock site access in your browser’s extension settings, then reload this page for a fresh check.',
  },
  'adapter-incompatible': {
    title: 'Wallet protocol is incompatible',
    detail:
      'Gryd Lock observed an unsupported wallet protocol. This signing route is not protected.',
  },
  unsupported: {
    title: 'Wallet route is unsupported',
    detail: 'This route does not provide an inspectable transaction payload and is not protected.',
  },
  unknown: {
    title: 'Protection status unknown',
    detail: 'Wait for a current health check before relying on Gryd Lock protection.',
  },
}

const initialSnapshot: ProtectionSnapshot = {
  status: 'unknown',
  adapter: null,
  checkedAt: null,
  freshUntil: null,
}

async function activeTabId(): Promise<number | undefined> {
  if (!chrome.tabs?.query) return undefined
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return tab?.id
}

export default function ProtectionStatusPanel() {
  const [snapshot, setSnapshot] = useState<ProtectionSnapshot>(initialSnapshot)

  const refresh = async () => {
    try {
      const tabId = await activeTabId()
      if (!chrome?.runtime?.sendMessage) {
        setSnapshot({ ...initialSnapshot, status: 'worker-unavailable' })
        return
      }

      chrome.runtime.sendMessage(
        { type: 'GET_PROTECTION_STATUS', tabId },
        (response?: ProtectionSnapshot) => {
          if (chrome.runtime.lastError) {
            setSnapshot({ ...initialSnapshot, status: 'worker-unavailable' })
            return
          }
          if (!response || !STATUS_COPY[response.status]) {
            setSnapshot({ ...initialSnapshot, status: 'worker-unavailable' })
            return
          }
          setSnapshot(response)
        },
      )
    } catch {
      setSnapshot({ ...initialSnapshot, status: 'worker-unavailable' })
    }
  }

  useEffect(() => {
    const tick = () => {
      void refresh()
    }

    tick()
    const interval = window.setInterval(tick, 5_000)
    return () => {
      window.clearInterval(interval)
    }
  }, [])

  const copy = STATUS_COPY[snapshot.status]
  return (
    <main
      className="popup protection-status"
      aria-live="polite"
      data-protection-status={snapshot.status}
    >
      <h1>{copy.title}</h1>
      <p>{copy.detail}</p>
      {snapshot.adapter && <p className="status-meta">Adapter: {snapshot.adapter}</p>}
      <button type="button" className="proceed" onClick={() => void refresh()}>
        Refresh status
      </button>
      <p className="status-meta">A health check never signs, submits, or reads a transaction.</p>
    </main>
  )
}
