import { extractDestination } from '../decode/decodeTransaction'
import { getScore } from '../adapter/oracleAdapter'
import { resolveOutcome } from '../intercept/resolveOutcome'
import { recordDecision } from '../lib/history'
import { tierForScore } from '../lib/tiers'
import type {
  Decision,
  RuntimeDecisionMadeMessage,
  RuntimeSignOutcomeMessage,
  RuntimeSignRequestMessage,
} from '../intercept/protocol'

type IncomingMessage = RuntimeSignRequestMessage | RuntimeDecisionMadeMessage

export const DEFAULT_TIMEOUT_MS = 60_000

export const pendingDecisions = new Map<string, (decision: Decision) => void>()

export function requestDecision(
  requestId: string,
  info: { destinations: { destination: string; asset?: string }[]; scores: Array<{ destination: string; asset?: string; score: number }>; worstScore: number },
): Promise<Decision> {
  return new Promise((resolve) => {
    pendingDecisions.set(requestId, (decision) => {
      // History stays on-device (chrome.storage.local); a write failure must
      // never block the signing flow, so record fire-and-forget.
      void recordDecision({
        destination: info.destination,
        asset: info.asset,
        score: info.score,
        tier: tierForScore(info.score).tier,
        decision,
        timestamp: Date.now(),
      }).catch(() => {})
      resolve(decision)
    })

    const params = new URLSearchParams({
      requestId,
      score: String(info.worstScore),
    })

    const mapped = info.scores.map((item) => ({
      destination: item.destination,
      asset: item.asset ?? '',
      score: item.score,
    }))
    if (mapped.length > 1) {
      mapped.sort((a, b) => b.score - a.score)
      params.set('destinations', JSON.stringify(mapped))
    } else if (mapped.length === 1) {
      const first = mapped[0]
      params.set('destination', first.destination)
      if (first.asset) params.set('asset', first.asset)
    }

export function getQueueKey(sender: chrome.runtime.MessageSender): string {
  const tabId = sender.tab?.id
  const origin = sender.origin || 'unknown'
  return tabId ? `tab-${tabId}` : `origin-${origin}`
}

export function processNextInQueue(queueKey: string) {
  const q = queues.get(queueKey)
  if (!q || q.length === 0) {
    activeWindows.delete(queueKey)
    return
  }

  // If there is already an active window with a windowId or a pending window creation, do not process the next one yet
  if (activeWindows.has(queueKey)) {
    return
  }

  const next = q.shift()!

  // Reserve the active window slot for this queue key
  activeWindows.set(queueKey, { requestId: next.requestId })

  pendingDecisions.set(next.requestId, (decision) => {
    pendingDecisions.delete(next.requestId)
    activeWindows.delete(queueKey)
    next.resolve(decision)
    // Process next queued request for this queue key
    processNextInQueue(queueKey)
  })

  const params = new URLSearchParams({
    mode: 'intercept',
    requestId: next.requestId,
    destination: next.info.destination,
    score: String(next.info.score),
  })
  if (next.info.asset) params.set('asset', next.info.asset)

  chrome.windows.create(
    {
      url: chrome.runtime.getURL(`src/popup/index.html?${params.toString()}`),
      type: 'popup',
      width: 320,
      height: 420,
    },
    (window) => {
      if (window) {
        // Update the active window info with the actual windowId
        const active = activeWindows.get(queueKey)
        if (active && active.requestId === next.requestId) {
          activeWindows.set(queueKey, { windowId: window.id, requestId: next.requestId })
        }
      } else {
        // Failed to create window, resolve immediately
        const resolve = pendingDecisions.get(next.requestId)
        if (resolve) {
          resolve('cancel')
        }
      }
    }
  )
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const active of activeWindows.values()) {
    if (active.windowId === windowId) {
      const resolve = pendingDecisions.get(active.requestId)
      if (resolve) {
        resolve('cancel')
      }
      break
    }
  }
})

chrome.runtime.onMessage.addListener((message: IncomingMessage, sender, sendResponse) => {
  if (message.type === 'SIGN_REQUEST') {
    const queueKey = getQueueKey(sender)

    if (!checkRateLimit(queueKey)) {
      const response: RuntimeSignOutcomeMessage = {
        type: 'SIGN_OUTCOME',
        requestId: message.requestId,
        outcome: 'cancel',
      }
      sendResponse(response)
      return
    }

    resolveOutcome(message.xdr, {
      extractDestination,
      getScore,
      requestDecision: (info) =>
        new Promise<Decision>((resolve) => {
          let q = queues.get(queueKey)
          if (!q) {
            q = []
            queues.set(queueKey, q)
          }
          q.push({ requestId: message.requestId, info, resolve })
          processNextInQueue(queueKey)
        }),
    }).then((outcome) => {
      const response: RuntimeSignOutcomeMessage = {
        type: 'SIGN_OUTCOME',
        requestId: message.requestId,
        outcome,
      }
      sendResponse(response)
    })
      .then((outcome) => {
        const response: RuntimeSignOutcomeMessage = {
          type: 'SIGN_OUTCOME',
          requestId: message.requestId,
          outcome,
        }
        sendResponse(response)
      })
      .catch(() => {
        // Last-resort safety net: if resolveOutcome rejects for any unexpected
        // reason, cancel the transaction rather than leaving the bridge hanging.
        const response: RuntimeSignOutcomeMessage = {
          type: 'SIGN_OUTCOME',
          requestId: message.requestId,
          outcome: 'cancel',
        }
        sendResponse(response)
      })

      return true
    }

  if (message.type === 'DECISION_MADE') {
    const resolve = pendingDecisions.get(message.requestId)
    resolve?.(message.decision)
  }

    return undefined
  })
}
