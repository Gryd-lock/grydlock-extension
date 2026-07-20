export type Tier = 'low' | 'elevated' | 'high' | 'critical' | 'unscored'

export interface TierInfo {
  tier: Tier
  label: string
  /** Hex colour used for visual accents (border, badge) in light mode.
   *  All values meet WCAG 2.1 AA contrast (≥ 4.5:1) against white (#ffffff). */
  colour: string
  /** Hex colour used for visual accents (border, badge) in dark mode.
   *  All values meet WCAG 2.1 AA contrast (≥ 4.5:1) against the popup dark background. */
  darkColour: string
  /** Unicode icon that conveys tier without relying on colour alone. */
  icon: string
  message: string
}

const TIERS: Array<{ max: number; info: TierInfo }> = [
  {
    max: 20,
    info: {
      tier: 'low',
      label: 'Low',
      colour: '#2e7d32', // 5.13:1 on white — WCAG AA ✓
      darkColour: '#66bb6a', // 7.50:1 on #111827 — WCAG AA ✓
      icon: '✓',
      message: 'No signs of a risky destination.',
    },
  },
  {
    max: 50,
    info: {
      tier: 'elevated',
      label: 'Elevated',
      colour: '#a86300', // 4.72:1 on white — WCAG AA ✓  (was #f9a825 @ 1.97:1 — FAIL)
      darkColour: '#f6ad55', // 9.32:1 on #111827 — WCAG AA ✓
      icon: '⚠',
      message: 'Some unusual signals — double-check the destination.',
    },
  },
  {
    max: 75,
    info: {
      tier: 'high',
      label: 'High',
      colour: '#bf360c', // 5.60:1 on white — WCAG AA ✓  (was #ef6c00 @ 3.08:1 — FAIL)
      darkColour: '#ff8a65', // 7.67:1 on #111827 — WCAG AA ✓
      icon: '⚠',
      message: 'Strong indicators of risk. Confirm you trust this destination.',
    },
  },
  {
    max: 100,
    info: {
      tier: 'critical',
      label: 'Critical',
      colour: '#c62828', // 5.62:1 on white — WCAG AA ✓
      darkColour: '#ef9a9a', // 8.24:1 on #111827 — WCAG AA ✓
      icon: '✕',
      message: 'This destination looks fraudulent. Cancelling is strongly recommended.',
    },
  },
]

/**
 * Sentinel TierInfo used when the risk oracle is unreachable and no score
 * could be obtained. Must be visually distinct from every scored tier so
 * the user can clearly tell this is an assessment failure, not a low-risk result.
 */
export const UNSCORED_TIER_INFO: TierInfo = {
  tier: 'unscored',
  label: 'Unknown',
  colour: '#5c6bc0', // indigo — distinct from all scored-tier colours
  icon: '?',
  message: "Couldn't reach the risk oracle. Proceed only if you fully trust this destination.",
}

export function tierForScore(score: number): TierInfo {
  const clamped = Math.max(0, Math.min(100, score))
  const match = TIERS.find(({ max }) => clamped <= max)
  return match!.info
}
