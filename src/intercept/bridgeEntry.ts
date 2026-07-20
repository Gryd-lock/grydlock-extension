import {
  WINDOW_REQUEST_TYPE,
  WINDOW_RESPONSE_TYPE,
  type RuntimeSignOutcomeMessage,
  type RuntimeSignRequestMessage,
} from './protocol'

window.addEventListener('message', (event) => {
  if (event.source !== window) return
  const data = event.data as
    | { type?: string; requestId?: string; xdr?: string; networkPassphrase?: string }
    | undefined
  if (data?.type !== WINDOW_REQUEST_TYPE || !data.requestId || !data.xdr) return

  const message: RuntimeSignRequestMessage = {
    type: 'SIGN_REQUEST',
    requestId: data.requestId,
    xdr: data.xdr,
    networkPassphrase: data.networkPassphrase,
  }

  chrome.runtime.sendMessage(message, (response: RuntimeSignOutcomeMessage | undefined) => {
    window.postMessage(
      { type: WINDOW_RESPONSE_TYPE, requestId: data.requestId, outcome: response?.outcome ?? 'cancel' },
      '*',
    )
  })
})
