import { describe, it, expect } from 'vitest'
import freighterRequestFixture from '../../tests/fixtures/contracts/freighter/submit-tx-request.json'
import freighterDeclineFixture from '../../tests/fixtures/contracts/freighter/decline-response.json'
import albedoRequestFixture from '../../tests/fixtures/contracts/albedo/tx-intent-request.json'
import albedoRejectFixture from '../../tests/fixtures/contracts/albedo/reject-response.json'


interface AlbedoIntentPayload {
  intent?: unknown
  xdr?: unknown
  network?: unknown
  __reqid?: unknown
}

describe('Wallet Protocol Contract Verifications', () => {
  describe('Freighter Protocol Contract', () => {
    it('validates submission request message shape', () => {
      // Enforces expected @stellar/freighter-api envelope
      expect(freighterRequestFixture.source).toBe('FREIGHTER_EXTERNAL_MSG_REQUEST')
      expect(freighterRequestFixture.type).toBe('SUBMIT_TRANSACTION')
      expect(typeof freighterRequestFixture.transactionXdr).toBe('string')
      expect(typeof freighterRequestFixture.networkPassphrase).toBe('string')
    })

    it('matches synthetic decline response signature', () => {
      // Gryd Lock synthesizes a decline when user cancels
      expect(freighterDeclineFixture.source).toBe('FREIGHTER_EXTERNAL_MSG_RESPONSE')
      expect(freighterDeclineFixture.type).toBe('SUBMIT_TRANSACTION_RESPONSE')
      expect(freighterDeclineFixture.status).toBe('rejected')
      expect(freighterDeclineFixture.error).toBeDefined()
    })
  })

  describe('Albedo Intent Protocol Contract', () => {
    it('identifies destination-bearing intent payloads', () => {
      // Albedo popup proxy checks for intent === 'tx' | 'pay' and presence of xdr
      const isDestinationBearingIntent = (payload: AlbedoIntentPayload) => {
        return ['tx', 'pay'].includes(payload.intent as string) && typeof payload.xdr === 'string'
      }

      expect(isDestinationBearingIntent(albedoRequestFixture)).toBe(true)
      expect(albedoRequestFixture.__reqid).toBeDefined()
    })

    it('matches Albedo standard error rejection shape (code -4)', () => {
      const result = albedoRejectFixture.albedoIntentResult

      // Albedo standard cancellation contract
      expect(result.status).toBe('rejected')
      expect(result.code).toBe(-4)
      expect(result.__reqid).toBe(albedoRequestFixture.__reqid)
    })
  })
})
