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

const pendingDecisions = new Map<string, (decision: Decision) => void>()

function requestDecision(
  requestId: string,
  info: { destination: string; asset?: string; score: number | null },
): Promise<Decision> {
  return new Promise((resolve) => {
    pendingDecisions.set(requestId, resolve)

    const params = new URLSearchParams({
      mode: 'intercept',
      requestId,
      destination: info.destination,
    })
    if (info.score !== null) params.set('score', String(info.score))
    if (info.asset) params.set('asset', info.asset)

    chrome.windows.create({
      url: chrome.runtime.getURL(`src/popup/index.html?${params.toString()}`),
      type: 'popup',
      width: 320,
      height: 420,
    })
  })
}

chrome.runtime.onMessage.addListener((message: IncomingMessage, _sender, sendResponse) => {
  if (message.type === 'SIGN_REQUEST') {
    resolveOutcome(message.xdr, {
      extractDestination,
      getScore,
      requestDecision: (info) => requestDecision(message.requestId, info),
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
    pendingDecisions.delete(message.requestId)
  }

  return undefined
})
