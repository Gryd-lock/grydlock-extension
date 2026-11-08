import { describe, expect, it, vi } from 'vitest'
import { OracleTimeoutError, UnrecognizedDestinationError, type RiskOracle } from 'grydlock-oracle-adapter'
import testkitScores from 'grydlock-testkit/scores.json'
import {
  DEFAULT_ORACLE_SOURCE,
  STUB_ORACLE_UNKNOWN_SCORE,
  createRiskOracle,
  lookupScore,
} from './oracleAdapter'

// From grydlock-testkit destinations.json.
const SUSPICIOUS = 'GCRNKXJJLZNDLK2EWPX25JISTORCXCF2HYUXMYKF7XWKHMEOHCXVGP4J' // 55
const MALICIOUS = 'GD7XPB2A7CG5Z4ICV24B3LXCRHAEJRFEK4OEW3ZIOQAPJOHAXBB7QHGE' // 92
const NOT_IN_FIXTURES = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57'

function oracleOf(getScore: RiskOracle['getScore']): RiskOracle {
  return { getScore }
}

describe('oracle source', () => {
  it('defaults to off: no oracle, so no score is ever produced', () => {
    expect(DEFAULT_ORACLE_SOURCE).toEqual({ kind: 'off' })
    expect(createRiskOracle(DEFAULT_ORACLE_SOURCE)).toBeNull()
  })

  it('returns the vendored testkit score for fixture destinations', async () => {
    const oracle = createRiskOracle({ kind: 'testkit-fixtures' })!
    await expect(lookupScore(oracle, SUSPICIOUS)).resolves.toEqual({ status: 'available', score: 55 })
    await expect(lookupScore(oracle, MALICIOUS)).resolves.toEqual({ status: 'available', score: 92 })
  })

  it('reports destinations missing from the fixtures as unscored, not as score 0', async () => {
    const oracle = createRiskOracle({ kind: 'testkit-fixtures' })!
    await expect(lookupScore(oracle, NOT_IN_FIXTURES)).resolves.toEqual({ status: 'unscored' })
  })

  it('relies on no testkit fixture legitimately scoring the StubOracle default', () => {
    // If this fails, a real fixture would be misreported as "unscored".
    for (const [destination, score] of Object.entries(testkitScores)) {
      expect(score, destination).not.toBe(STUB_ORACLE_UNKNOWN_SCORE)
    }
  })
})

describe('lookupScore', () => {
  it('maps the package unrecognized-destination error to unscored', async () => {
    const oracle = oracleOf(vi.fn().mockRejectedValue(new UnrecognizedDestinationError('G')))
    await expect(lookupScore(oracle, 'G')).resolves.toEqual({ status: 'unscored' })
  })

  it('maps timeouts and other failures to unavailable', async () => {
    await expect(
      lookupScore(oracleOf(vi.fn().mockRejectedValue(new OracleTimeoutError())), 'G'),
    ).resolves.toEqual({ status: 'unavailable' })
    await expect(
      lookupScore(oracleOf(vi.fn().mockRejectedValue(new Error('network down'))), 'G'),
    ).resolves.toEqual({ status: 'unavailable' })
  })

  it.each([-1, 101, 42.5, Number.NaN])('treats out-of-contract score %s as unavailable', async (score) => {
    await expect(lookupScore(oracleOf(vi.fn().mockResolvedValue(score)), 'G')).resolves.toEqual({
      status: 'unavailable',
    })
  })
})
