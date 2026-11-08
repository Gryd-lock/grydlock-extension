// @vitest-environment node
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { Networks } from '@stellar/stellar-sdk'
import { buildAggregatedReview } from '../intercept/resolveOutcome'
import { createRiskOracle, lookupScore } from '../adapter/oracleAdapter'
import { displayTier } from './policy'

const require = createRequire(import.meta.url)
const fixture = (name: string) =>
  readFileSync(require.resolve(`grydlock-testkit/transactions/${name}`), 'utf8').trim()

const PAYMENT_XDR = fixture('payment.xdr') // -> suspicious_wallet_1 (fixture score 55)
const PATH_PAYMENT_XDR = fixture('path_payment.xdr') // -> malicious_wallet_1 (fixture score 92)

describe('honest default: destination scoring off', () => {
  it('shows Unknown, not Low, and adds no invented finding', async () => {
    const review = await buildAggregatedReview(PAYMENT_XDR, { oracleSource: 'off' }, Networks.TESTNET)
    expect(review).not.toBeNull()
    expect(review!.evidence.map((item) => item.status)).toEqual(['not-configured'])
    expect(review!.evidence[0].score).toBeUndefined()
    expect(review!.findings.filter((f) => f.code.startsWith('oracle-'))).toEqual([])
    expect(displayTier(review!)).toBe('unscored')
  })
})

describe('testkit fixture scoring', () => {
  const oracle = createRiskOracle({ kind: 'testkit-fixtures' })!
  const deps = {
    oracleSource: 'testkit-fixtures' as const,
    lookupScore: (target: { value: string }) => lookupScore(oracle, target.value),
  }

  it('scores the testkit payment destination as High', async () => {
    const review = await buildAggregatedReview(PAYMENT_XDR, deps, Networks.TESTNET)
    expect(review!.evidence[0]).toMatchObject({ status: 'available', score: 55 })
    expect(displayTier(review!)).toBe('high')
  })

  it('scores the testkit path payment destination as Critical', async () => {
    const review = await buildAggregatedReview(PATH_PAYMENT_XDR, deps, Networks.TESTNET)
    expect(review!.evidence[0]).toMatchObject({ status: 'available', score: 92 })
    expect(displayTier(review!)).toBe('critical')
  })
})

describe('displayTier', () => {
  const target = { type: 'account' as const, value: 'G', networkPassphrase: Networks.TESTNET }

  it('is Low only when every scoreable destination has a score', () => {
    expect(displayTier({ severity: 'info', evidence: [] })).toBe('low')
    expect(displayTier({ severity: 'info', evidence: [{ target, status: 'available', score: 3 }] })).toBe('low')
    expect(displayTier({ severity: 'info', evidence: [{ target, status: 'unscored' }] })).toBe('unscored')
  })

  it('lets semantic findings drive the tier even without a score', () => {
    expect(displayTier({ severity: 'critical', evidence: [{ target, status: 'not-configured' }] })).toBe('critical')
  })
})
