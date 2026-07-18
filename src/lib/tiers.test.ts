import { describe, expect, it } from 'vitest'
import { tierForScore } from './tiers'

// ---------------------------------------------------------------------------
// WCAG 2.1 AA contrast helpers
// ---------------------------------------------------------------------------

/** Convert an sRGB channel (0-255) to linear light. */
function linearise(c: number): number {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

/** Relative luminance of a hex colour (e.g. '#2e7d32'). */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b)
}

/** WCAG contrast ratio between two hex colours. */
function contrastRatio(hex1: string, hex2: string): number {
  const l1 = luminance(hex1)
  const l2 = luminance(hex2)
  const [lighter, darker] = l1 > l2 ? [l1, l2] : [l2, l1]
  return (lighter + 0.05) / (darker + 0.05)
}

// ---------------------------------------------------------------------------
// Tier mapping tests
// ---------------------------------------------------------------------------

describe('tierForScore', () => {
  it('maps boundary scores to the correct tier', () => {
    expect(tierForScore(0).tier).toBe('low')
    expect(tierForScore(20).tier).toBe('low')
    expect(tierForScore(21).tier).toBe('elevated')
    expect(tierForScore(50).tier).toBe('elevated')
    expect(tierForScore(51).tier).toBe('high')
    expect(tierForScore(75).tier).toBe('high')
    expect(tierForScore(76).tier).toBe('critical')
    expect(tierForScore(100).tier).toBe('critical')
  })

  it('clamps out-of-range scores', () => {
    expect(tierForScore(-5).tier).toBe('low')
    expect(tierForScore(150).tier).toBe('critical')
  })
})

// ---------------------------------------------------------------------------
// WCAG AA contrast regression tests
// Popup backgrounds are white (#ffffff) in light mode and #111827 in dark mode.
// If a tier colour change breaks this test, the PR is caught before merge.
// ---------------------------------------------------------------------------

const LIGHT_POPUP_BG = '#ffffff'
const DARK_POPUP_BG = '#111827'
const WCAG_AA_NORMAL_TEXT = 4.5

describe('tier colour WCAG AA contrast', () => {
  const tiers = [0, 21, 51, 76].map((score) => tierForScore(score))

  it('every tier colour meets ≥ 4.5:1 contrast against white (#ffffff)', () => {
    for (const tier of tiers) {
      const ratio = contrastRatio(tier.colour, LIGHT_POPUP_BG)
      expect(
        ratio,
        `${tier.tier} (${tier.colour}) contrast ${ratio.toFixed(2)}:1 < ${WCAG_AA_NORMAL_TEXT}:1`,
      ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT)
    }
  })

  it('every dark-mode tier colour meets ≥ 4.5:1 contrast against #111827', () => {
    for (const tier of tiers) {
      const ratio = contrastRatio(tier.darkColour, DARK_POPUP_BG)
      expect(
        ratio,
        `${tier.tier} (${tier.darkColour}) contrast ${ratio.toFixed(2)}:1 < ${WCAG_AA_NORMAL_TEXT}:1`,
      ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT)
    }
  })

  it('every tier has a non-empty icon so colour is not the sole differentiator', () => {
    for (const tier of tiers) {
      expect(tier.icon, `${tier.tier} tier is missing an icon`).toBeTruthy()
    }
  })
})
