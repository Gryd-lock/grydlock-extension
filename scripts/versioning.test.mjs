import { describe, expect, it } from 'vitest'
import {
  assertMatchingVersions,
  assertTagMatchesVersion,
  normalizeTagVersion,
  releaseArchiveName,
} from './versioning.mjs'

describe('versioning helpers', () => {
  it('accepts matching package and manifest versions', () => {
    expect(() => assertMatchingVersions('0.1.0', '0.1.0')).not.toThrow()
  })

  it('throws when package and manifest versions diverge', () => {
    expect(() => assertMatchingVersions('0.1.0', '0.1.1')).toThrow(/Version mismatch/)
  })

  it('normalizes a v-prefixed tag', () => {
    expect(normalizeTagVersion('v0.1.0')).toBe('0.1.0')
  })

  it('accepts a matching release tag', () => {
    expect(() => assertTagMatchesVersion('v0.1.0', '0.1.0')).not.toThrow()
  })

  it('throws when a release tag does not match the project version', () => {
    expect(() => assertTagMatchesVersion('v0.1.1', '0.1.0')).toThrow(/does not match/)
  })

  it('builds the expected release archive name', () => {
    expect(releaseArchiveName('0.1.0')).toBe('grydlock-extension-v0.1.0.zip')
  })
})
