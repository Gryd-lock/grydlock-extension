import { extractDestination } from '../decode/decodeTransaction'
import { getScore } from '../adapter/oracleAdapter'
import { resolveOutcome } from '../intercept/resolveOutcome'
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
  info: { destination: string; asset?: string; score: number },
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Decision> {
  return new Promise((resolve) => {
    let windowId: number | undefined
    let timerId: ReturnType<typeof setTimeout> | undefined

    const cleanup = () => {
      if (timerId !== undefined) {
        clearTimeout(timerId)
        timerId = undefined
      }
      pendingDecisions.delete(requestId)
    }

    const resolveWith = (decision: Decision) => {
      cleanup()
      resolve(decision)
    }

    timerId = setTimeout(() => {
      if (windowId !== undefined) {
        chrome.windows.remove(windowId).catch(() => {})
      }
      resolveWith('cancel')
    }, timeoutMs)

    pendingDecisions.set(requestId, resolveWith)

    const expiresAt = Date.now() + timeoutMs

    const params = new URLSearchParams({
      mode: 'intercept',
      requestId,
      destination: info.destination,
      score: String(info.score),
      expiresAt: String(expiresAt),
    })
    if (info.asset) params.set('asset', info.asset)

    chrome.windows.create({
      url: chrome.runtime.getURL(`src/popup/index.html?${params.toString()}`),
      type: 'popup',
      width: 320,
      height: 420,
    }).then((createdWindow) => {
      if (createdWindow?.id !== undefined) {
        windowId = createdWindow.id
      }
    }).catch(() => {})
  })
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message: IncomingMessage, _sender, sendResponse) => {
    if (message.type === 'SIGN_REQUEST') {
      resolveOutcome(message.xdr, {
        extractDestination,
        getScore,
        requestDecision: (info) => requestDecision(message.requestId, info),
      }).then((outcome) => {
        const response: RuntimeSignOutcomeMessage = {
          type: 'SIGN_OUTCOME',
          requestId: message.requestId,
          outcome,
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
