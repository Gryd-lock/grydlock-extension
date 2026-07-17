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
  info: { destinations: { destination: string; asset?: string }[]; scores: Array<{ destination: string; asset?: string; score: number }>; worstScore: number },
): Promise<Decision> {
  return new Promise((resolve) => {
    pendingDecisions.set(requestId, resolve)

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

    chrome.windows.create({
      url: chrome.runtime.getURL(`src/popup/index.html?${params.toString()}`),
      type: 'popup',
      width: 400,
      height: 520,
    })
  })
}

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
    pendingDecisions.delete(message.requestId)
  }

  return undefined
})
