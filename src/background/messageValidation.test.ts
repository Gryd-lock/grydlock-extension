import { describe, expect, it } from 'vitest'
import {
  MAX_NETWORK_PASSPHRASE_LENGTH,
  MAX_REQUEST_ID_LENGTH,
  MAX_XDR_LENGTH,
  isRuntimeAwaitOutcomeMessage,
  isRuntimeDecisionMadeMessage,
  isRuntimeProtectionAdapterStatusMessage,
  isRuntimeProtectionBridgeOnlineMessage,
  isRuntimeProtectionHandshakeAckMessage,
  isRuntimeProtectionHandshakeMessage,
  isRuntimeReviewRequestMessage,
  isRuntimeSignRequestMessage,
} from './messageValidation'

describe('isRuntimeSignRequestMessage', () => {
  it('accepts valid requests with and without a network passphrase', () => {
    expect(
      isRuntimeSignRequestMessage({
        type: 'SIGN_REQUEST',
        protocolVersion: 1,
        xdr: 'AAAAAg==',
        adapter: 'freighter',
      }),
    ).toBe(true)

    expect(
      isRuntimeSignRequestMessage({
        type: 'SIGN_REQUEST',
        protocolVersion: 1,
        xdr: 'AAAAAg==',
        adapter: 'albedo-popup',
        networkPassphrase: 'Test SDF Network ; September 2015',
      }),
    ).toBe(true)
  })

  it('has no requestId field at all — the page/bridge boundary correlation id never reaches this message', () => {
    expect(
      isRuntimeSignRequestMessage({
        type: 'SIGN_REQUEST',
        protocolVersion: 1,
        xdr: 'AAAAAg==',
        adapter: 'freighter',
        requestId: 'page-supplied-id',
      }),
    ).toBe(false)
  })

  it('accepts values exactly at each explicit size limit', () => {
    expect(
      isRuntimeSignRequestMessage({
        type: 'SIGN_REQUEST',
        protocolVersion: 1,
        xdr: 'A'.repeat(MAX_XDR_LENGTH),
        adapter: 'freighter',
        networkPassphrase: 'n'.repeat(MAX_NETWORK_PASSPHRASE_LENGTH),
      }),
    ).toBe(true)
  })

  it.each([
    null,
    undefined,
    'SIGN_REQUEST',
    [],
    {},
    { type: 'SIGN_REQUEST' },
    { type: 'SIGN_REQUEST', protocolVersion: 1 },
    { type: 'SIGN_REQUEST', protocolVersion: '1', xdr: 'AAAAAg==', adapter: 'freighter' },
    { type: 'SIGN_REQUEST', protocolVersion: 1, xdr: 1, adapter: 'freighter' },
    { type: 'SIGN_REQUEST', protocolVersion: 1, xdr: 'AAAAAg==', adapter: 'metamask' },
    { type: 'SIGN_REQUEST', protocolVersion: 1, xdr: 'AAAAAg==', adapter: undefined },
    {
      type: 'SIGN_REQUEST',
      protocolVersion: 1,
      xdr: 'AAAAAg==',
      adapter: 'freighter',
      networkPassphrase: 1,
    },
    { type: 'OTHER', protocolVersion: 1, xdr: 'AAAAAg==', adapter: 'freighter' },
  ])('rejects malformed values %#', (message) => {
    expect(isRuntimeSignRequestMessage(message)).toBe(false)
  })

  it.each([
    { type: 'SIGN_REQUEST', protocolVersion: 1, xdr: '', adapter: 'freighter' },
    { type: 'SIGN_REQUEST', protocolVersion: 1, xdr: '   ', adapter: 'freighter' },
    {
      type: 'SIGN_REQUEST',
      protocolVersion: 1,
      xdr: 'AAAAAg==',
      adapter: 'freighter',
      networkPassphrase: '',
    },
    {
      type: 'SIGN_REQUEST',
      protocolVersion: 1,
      xdr: 'AAAAAg==',
      adapter: 'freighter',
      networkPassphrase: '   ',
    },
  ])('rejects empty required or supplied strings %#', (message) => {
    expect(isRuntimeSignRequestMessage(message)).toBe(false)
  })

  it.each([
    {
      type: 'SIGN_REQUEST',
      protocolVersion: 1,
      xdr: 'A'.repeat(MAX_XDR_LENGTH + 1),
      adapter: 'freighter',
    },
    {
      type: 'SIGN_REQUEST',
      protocolVersion: 1,
      xdr: 'AAAAAg==',
      adapter: 'freighter',
      networkPassphrase: 'n'.repeat(MAX_NETWORK_PASSPHRASE_LENGTH + 1),
    },
  ])('rejects values over each explicit size limit %#', (message) => {
    expect(isRuntimeSignRequestMessage(message)).toBe(false)
  })
})

describe('isRuntimeAwaitOutcomeMessage', () => {
  it('accepts a bounded, closed-set resume/status request', () => {
    expect(isRuntimeAwaitOutcomeMessage({ type: 'AWAIT_OUTCOME', requestId: 'req-1' })).toBe(true)
  })

  it.each([
    null,
    undefined,
    {},
    { type: 'AWAIT_OUTCOME' },
    { type: 'AWAIT_OUTCOME', requestId: '' },
    { type: 'AWAIT_OUTCOME', requestId: 1 },
    { type: 'AWAIT_OUTCOME', requestId: 'req-1', xdr: 'extra' },
    { type: 'AWAIT_OUTCOME', requestId: 'r'.repeat(MAX_REQUEST_ID_LENGTH + 1) },
  ])('rejects malformed values %#', (message) => {
    expect(isRuntimeAwaitOutcomeMessage(message)).toBe(false)
  })
})

describe('protection health message validation', () => {
  const health = {
    type: 'PROTECTION_HANDSHAKE',
    nonce: 'health-nonce',
    adapter: 'freighter',
    protocolVersion: 1,
  }

  it('accepts the closed-set non-financial handshake and acknowledgment shapes', () => {
    expect(
      isRuntimeProtectionBridgeOnlineMessage({
        type: 'PROTECTION_BRIDGE_ONLINE',
        protocolVersion: 1,
      }),
    ).toBe(true)
    expect(isRuntimeProtectionHandshakeMessage(health)).toBe(true)
    expect(
      isRuntimeProtectionHandshakeAckMessage({ ...health, type: 'PROTECTION_HANDSHAKE_ACK' }),
    ).toBe(true)
  })

  it('rejects incompatible, malformed, and value-bearing health payloads', () => {
    expect(isRuntimeProtectionHandshakeMessage({ ...health, protocolVersion: 2 })).toBe(false)
    expect(isRuntimeProtectionHandshakeMessage({ ...health, nonce: '' })).toBe(false)
    expect(isRuntimeProtectionHandshakeMessage({ ...health, xdr: 'AAAA-real-transaction' })).toBe(
      false,
    )
    expect(isRuntimeProtectionHandshakeMessage({ ...health, account: 'GACCOUNT' })).toBe(false)
    expect(
      isRuntimeProtectionHandshakeAckMessage({
        ...health,
        type: 'PROTECTION_HANDSHAKE_ACK',
        decision: 'proceed',
      }),
    ).toBe(false)
    expect(
      isRuntimeProtectionBridgeOnlineMessage({
        type: 'PROTECTION_BRIDGE_ONLINE',
        protocolVersion: 1,
        url: 'https://dapp.example',
      }),
    ).toBe(false)
  })

  it('accepts only known adapter failure classifications', () => {
    expect(
      isRuntimeProtectionAdapterStatusMessage({
        type: 'PROTECTION_ADAPTER_STATUS',
        adapter: 'albedo-popup',
        status: 'unsupported',
        protocolVersion: 1,
      }),
    ).toBe(true)
    expect(
      isRuntimeProtectionAdapterStatusMessage({
        type: 'PROTECTION_ADAPTER_STATUS',
        adapter: 'albedo-popup',
        status: 'healthy',
        protocolVersion: 1,
      }),
    ).toBe(false)
  })
})

describe('isRuntimeDecisionMadeMessage', () => {
  it.each(['proceed', 'cancel'] as const)('accepts a valid %s decision', (decision) => {
    expect(
      isRuntimeDecisionMadeMessage({
        type: 'DECISION_MADE',
        protocolVersion: 1,
        requestId: 'req-1',
        decision,
      }),
    ).toBe(true)
  })

  it.each([
    null,
    undefined,
    [],
    {},
    { type: 'DECISION_MADE', protocolVersion: 1 },
    { type: 'DECISION_MADE', protocolVersion: 1, requestId: 'req-1' },
    { type: 'DECISION_MADE', protocolVersion: 2, requestId: 'req-1', decision: 'proceed' },
    { type: 'DECISION_MADE', protocolVersion: 1, requestId: 1, decision: 'proceed' },
    { type: 'DECISION_MADE', protocolVersion: 1, requestId: '', decision: 'proceed' },
    { type: 'DECISION_MADE', protocolVersion: 1, requestId: 'req-1', decision: 'allow' },
    { type: 'DECISION_MADE', protocolVersion: 1, requestId: 'req-1', decision: 1 },
    {
      type: 'DECISION_MADE',
      protocolVersion: 1,
      requestId: 'r'.repeat(MAX_REQUEST_ID_LENGTH + 1),
      decision: 'cancel',
    },
  ])('rejects malformed decisions %#', (message) => {
    expect(isRuntimeDecisionMadeMessage(message)).toBe(false)
  })
})

describe('isRuntimeReviewRequestMessage', () => {
  it('accepts only the bounded, closed-set popup review request', () => {
    expect(
      isRuntimeReviewRequestMessage({ type: 'GET_REVIEW', protocolVersion: 1, requestId: 'req-1' }),
    ).toBe(true)
    expect(
      isRuntimeReviewRequestMessage({
        type: 'GET_REVIEW',
        protocolVersion: 1,
        requestId: 'req-1',
        xdr: 'secret',
      }),
    ).toBe(false)
    expect(
      isRuntimeReviewRequestMessage({ type: 'GET_REVIEW', protocolVersion: 2, requestId: 'req-1' }),
    ).toBe(false)
    expect(
      isRuntimeReviewRequestMessage({ type: 'GET_REVIEW', protocolVersion: 1, requestId: '' }),
    ).toBe(false)
    expect(
      isRuntimeReviewRequestMessage({
        type: 'GET_REVIEW',
        protocolVersion: 1,
        requestId: 'r'.repeat(MAX_REQUEST_ID_LENGTH + 1),
      }),
    ).toBe(false)
  })
})
