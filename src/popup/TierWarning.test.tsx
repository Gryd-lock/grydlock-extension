import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TierWarning from './TierWarning'
import { tierForScore } from '../lib/tiers'
import DevScoreSlider from './DevScoreSlider'

function renderWarning(score = 85, devControl?: React.ReactNode) {
  const onCancel = vi.fn()
  const onProceed = vi.fn()
  render(
    <TierWarning
      tier={tierForScore(score)}
      score={score}
      destination="GDEST"
      onCancel={onCancel}
      onProceed={onProceed}
      devControl={devControl}
    />,
  )
  return {
    onCancel,
    onProceed,
    user: userEvent.setup(),
    cancel: screen.getByRole('button', { name: 'Cancel' }),
    proceed: screen.getByRole('button', { name: 'Proceed' }),
  }
}

describe('TierWarning default focus', () => {
  it('focuses Cancel when the popup opens', () => {
    const { cancel } = renderWarning(10)
    expect(cancel).toHaveFocus()
  })

  it.each([
    ['high', 60],
    ['critical', 85],
  ])('focuses Cancel by default on the %s tier', (_label, score) => {
    const { cancel } = renderWarning(score)
    expect(cancel).toHaveFocus()
  })

  it('exposes the popup as a labelled modal dialog', () => {
    renderWarning(85)
    expect(screen.getByRole('dialog')).toHaveAccessibleName(/critical risk/i)
  })
})

describe('TierWarning keyboard navigation', () => {
  it('moves focus forwards with Tab and wraps at the end', async () => {
    const { user, cancel, proceed } = renderWarning(10)
    expect(cancel).toHaveFocus()

    await user.tab()
    expect(proceed).toHaveFocus()

    await user.tab()
    expect(cancel).toHaveFocus()
  })

  it('moves focus backwards with Shift+Tab and wraps at the start', async () => {
    const { user, cancel, proceed } = renderWarning(10)
    expect(cancel).toHaveFocus()

    await user.tab({ shift: true })
    expect(proceed).toHaveFocus()

    await user.tab({ shift: true })
    expect(cancel).toHaveFocus()
  })

  it('includes every interactive element in the cycle', async () => {
    const { user, cancel } = renderWarning(
      85,
      <DevScoreSlider score={85} onChange={() => {}} />,
    )
    const confirmation = screen.getByLabelText(/type critical to enable proceed/i)
    const slider = screen.getByLabelText(/dev: override score/i)

    expect(cancel).toHaveFocus()
    await user.tab()
    expect(slider).toHaveFocus()
    await user.tab()
    expect(confirmation).toHaveFocus()
    await user.tab()
    expect(cancel).toHaveFocus()
  })

  it('keeps focus inside the popup across a full cycle', async () => {
    const { user } = renderWarning()
    const popup = screen.getByRole('dialog')

    for (let i = 0; i < 6; i++) {
      await user.tab()
      expect(popup).toContainElement(document.activeElement as HTMLElement)
    }
  })

  it('pulls focus back into the popup if it escapes to the document body', async () => {
    const { user, cancel } = renderWarning()
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    expect(outside).toHaveFocus()

    await user.tab()
    expect(cancel).toHaveFocus()

    outside.remove()
  })
})

describe('TierWarning Escape key', () => {
  it.each([
    ['low', 10],
    ['elevated', 40],
    ['high', 60],
    ['critical', 85],
  ])('cancels on Escape for the %s tier', async (_label, score) => {
    const { user, onCancel, onProceed } = renderWarning(score)

    await user.keyboard('{Escape}')

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onProceed).not.toHaveBeenCalled()
  })

  it('cancels on Escape even when Proceed holds focus', async () => {
    const { user, onCancel, proceed } = renderWarning()
    proceed.focus()

    await user.keyboard('{Escape}')

    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('TierWarning button activation', () => {
  it('activates the focused Cancel button with Enter', async () => {
    const { user, onCancel } = renderWarning()
    await user.keyboard('{Enter}')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('activates the focused Cancel button with Space', async () => {
    const { user, onCancel } = renderWarning()
    await user.keyboard(' ')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('activates Proceed with Enter once it is tabbed to', async () => {
    const { user, onProceed, onCancel } = renderWarning(10)
    await user.tab()
    await user.keyboard('{Enter}')
    expect(onProceed).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('activates Proceed with Space once it is tabbed to', async () => {
    const { user, onProceed, onCancel } = renderWarning(10)
    await user.tab()
    await user.keyboard(' ')
    expect(onProceed).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })
})

describe('TierWarning mouse interaction', () => {
  it('still cancels on click', async () => {
    const { user, onCancel, cancel } = renderWarning()
    await user.click(cancel)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('still proceeds on click', async () => {
    const { user, onProceed, proceed } = renderWarning(10)
    await user.click(proceed)
    expect(onProceed).toHaveBeenCalledTimes(1)
  })
})
