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

// Map of pending decisions keyed by requestId
const pendingDecisions = new Map<string, (decision: Decision) => void>()
// Map of requestId to popup window id for cleanup on window close
const pendingWindows = new Map<string, number>()

function requestDecision(
  requestId: string,
  info: { destination: string; asset?: string; score: number },
): Promise<Decision> {
  const tierInfo = tierForScore(info.score)
  // Show badge while decision is pending
  chrome.action.setBadgeText({ text: '!' })
  chrome.action.setBadgeBackgroundColor({ color: tierInfo.colour })

  return new Promise((resolve) => {
    // Store resolver for later
    pendingDecisions.set(requestId, (decision) => {
      // Record decision asynchronously
      void recordDecision({
        destination: info.destination,
        asset: info.asset,
        score: info.score,
        tier: tierInfo.tier,
        decision,
        timestamp: Date.now(),
      }).catch(() => {})
      resolve(decision)
    })

    const params = new URLSearchParams({
      mode: 'intercept',
      requestId,
      destination: info.destination,
      score: String(info.score),
    })
    if (info.asset) params.set('asset', info.asset)

    // Create popup window (no callback for test compatibility)
    chrome.windows.create({
      url: chrome.runtime.getURL(`src/popup/index.html?${params.toString()}`),
      type: 'popup',
      width: 320,
      height: 420,
    }, (window) => {
      if (window?.id) {
        pendingWindows.set(requestId, window.id)
      }
    });
  })
}

// Clean up when a popup window is closed without a decision
// Use optional chaining to avoid errors in test environments without windows.onRemoved
chrome.windows?.onRemoved?.addListener((windowId) => {
  for (const [reqId, winId] of pendingWindows.entries()) {
    if (winId === windowId) {
      pendingWindows.delete(reqId);
      pendingDecisions.delete(reqId);
    }
  }
  if (pendingDecisions.size === 0) {
    chrome.action.setBadgeText({ text: '' });
  }
});

chrome.runtime.onMessage.addListener(
  (message: IncomingMessage, _sender, sendResponse) => {
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
      pendingWindows.delete(message.requestId)
      if (pendingDecisions.size === 0) {
        chrome.action.setBadgeText({ text: '' })
      }
    }

    return undefined
  },
)
