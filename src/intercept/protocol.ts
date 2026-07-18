export type Decision = 'proceed' | 'cancel'
export type Outcome = 'allow' | Decision

export const WINDOW_REQUEST_TYPE = 'GRYDLOCK_REQUEST_OUTCOME'
export const WINDOW_RESPONSE_TYPE = 'GRYDLOCK_OUTCOME_RESPONSE'

export interface RuntimeSignRequestMessage {
  type: 'SIGN_REQUEST'
  requestId: string
  xdr: string
  networkPassphrase?: string
}

export interface RuntimeSignOutcomeMessage {
  type: 'SIGN_OUTCOME'
  requestId: string
  outcome: Outcome
}

export interface RuntimeDecisionMadeMessage {
  type: 'DECISION_MADE'
  requestId: string
  decision: Decision
}
