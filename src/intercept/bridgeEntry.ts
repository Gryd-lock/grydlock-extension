import {
  WINDOW_REQUEST_TYPE,
  WINDOW_RESPONSE_TYPE,
  type RuntimeSignOutcomeMessage,
  type RuntimeSignRequestMessage,
} from './protocol'

window.addEventListener('message', (event) => {
  if (event.source !== window) return
  const data = event.data as
    | { type?: string; localId?: string; requestId?: string; xdr?: string; networkPassphrase?: string }
    | undefined
  const localId = data?.localId ?? data?.requestId
  if (data?.type !== WINDOW_REQUEST_TYPE || !localId || !data.xdr) return

  const message: RuntimeSignRequestMessage = {
    type: 'SIGN_REQUEST',
    requestId: localId,
    xdr: data.xdr,
    networkPassphrase: data.networkPassphrase,
  }

  chrome.runtime.sendMessage(message, (response: RuntimeSignOutcomeMessage | undefined) => {
    window.postMessage(
      { type: WINDOW_RESPONSE_TYPE, localId, outcome: response?.outcome ?? 'cancel' },
      '*',
    )
  })
})
