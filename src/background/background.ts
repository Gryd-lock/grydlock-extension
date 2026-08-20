import { getScore } from '../adapter/oracleAdapter'
import { extractDestination } from '../decode/decodeTransaction'
import { resolveOutcome } from '../intercept/resolveOutcome'
import type { Decision, RuntimeSignOutcomeMessage } from '../intercept/protocol'
import { recordDecision } from '../lib/history'
import { tierForScore } from '../lib/tiers'
import { isRuntimeDecisionMadeMessage, isRuntimeSignRequestMessage } from './messageValidation'

export const DEFAULT_TIMEOUT_MS = 60_000

interface PendingInfo {
  destinations: { destination: string; asset?: string }[]
  scores: Array<{ destination: string; asset?: string; score: number }>
  worstScore: number
}

export const pendingDecisions = new Map<string, (decision: Decision) => void>()

function clearBadgeIfIdle() {
  if (pendingDecisions.size === 0) {
    chrome.action.setBadgeText({ text: '' })
  }
}

function recordFirstDecision(info: PendingInfo, decision: Decision) {
  const first = info.scores[0]
  if (!first) return

  void recordDecision({
    destination: first.destination,
    asset: first.asset,
    score: first.score,
    tier: tierForScore(first.score).tier,
    decision,
    timestamp: Date.now(),
  }).catch(() => {})
}

export function requestDecision(requestId: string, info: PendingInfo): Promise<Decision> {
  const tierInfo = tierForScore(info.worstScore)
  chrome.action.setBadgeText({ text: '!' })
  chrome.action.setBadgeBackgroundColor({ color: tierInfo.colour })

  return new Promise((resolve) => {
    pendingDecisions.set(requestId, (decision) => {
      pendingDecisions.delete(requestId)
      recordFirstDecision(info, decision)
      resolve(decision)
      clearBadgeIfIdle()
    })

    const params = new URLSearchParams({
      mode: 'intercept',
      requestId,
      score: String(info.worstScore),
    })

    const mapped = info.scores.map((item) => ({
      destination: item.destination,
      asset: item.asset ?? '',
      score: item.score,
    }))

    if (mapped.length > 1) {
      params.set('destinations', JSON.stringify(mapped))
    } else if (mapped.length === 1) {
      const [first] = mapped
      params.set('destination', first.destination)
      if (first.asset) params.set('asset', first.asset)
    }

    chrome.windows.create({
      url: chrome.runtime.getURL(`src/popup/index.html?${params.toString()}`),
      type: 'popup',
      width: 320,
      height: 420,
    })
  })
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (isRuntimeSignRequestMessage(message)) {
    resolveOutcome(
      message.xdr,
      {
        extractDestination,
        getScore,
        requestDecision: (info) => requestDecision(message.requestId, info),
      },
      message.networkPassphrase,
    )
      .then((outcome) => {
        const response: RuntimeSignOutcomeMessage = {
          type: 'SIGN_OUTCOME',
          requestId: message.requestId,
          outcome,
        }
        sendResponse(response)
      })
      .catch(() => {
        const response: RuntimeSignOutcomeMessage = {
          type: 'SIGN_OUTCOME',
          requestId: message.requestId,
          outcome: 'cancel',
        }
        sendResponse(response)
      })

    return true
  }

  if (isRuntimeDecisionMadeMessage(message)) {
    const resolve = pendingDecisions.get(message.requestId)
    resolve?.(message.decision)
  }

  return undefined
})
