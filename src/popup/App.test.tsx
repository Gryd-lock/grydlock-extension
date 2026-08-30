import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe, toHaveNoViolations } from 'jest-axe'
import App from './App'
import * as adapter from '../adapter/oracleAdapter'

expect.extend(toHaveNoViolations)

describe('App', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.history.pushState(null, '', '?dev=score')
  })

  afterEach(() => {
    window.history.pushState(null, '', '/')
  })

  it('shows a loading state before the adapter resolves', () => {
    vi.spyOn(adapter, 'getScore').mockReturnValue(new Promise(() => {}))
    render(<App />)
    expect(screen.getByText(/checking destination/i)).toBeInTheDocument()
  })

  it('renders the matching tier once the adapter resolves', async () => {
    vi.spyOn(adapter, 'getScore').mockResolvedValue(85)
    render(<App />)
    expect(await screen.findByText(/critical risk/i)).toBeInTheDocument()
    expect(screen.getByText('Score: 85')).toBeInTheDocument()
    expect(screen.getByText(/critical risk/i).closest('.popup')).toHaveAttribute(
      'data-tier',
      'critical',
    )
    expect(screen.getByText(/critical risk/i).closest('.popup')).toHaveStyle({
      '--tier-accent-light': '#c62828',
      '--tier-accent-dark': '#ef9a9a',
    })
  })

  it('shows a retry option when the adapter call fails', async () => {
    vi.spyOn(adapter, 'getScore').mockRejectedValue(new Error('network down'))
    render(<App />)
    expect(await screen.findByText(/could not reach the risk oracle/i)).toBeInTheDocument()
  })

  it('retries the adapter call when Retry is clicked', async () => {
    vi.spyOn(adapter, 'getScore')
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(10)
    render(<App />)
    fireEvent.click(await screen.findByText('Retry'))
    expect(await screen.findByText(/low risk/i)).toBeInTheDocument()
  })

  it('lets the dev slider override the displayed tier', async () => {
    vi.spyOn(adapter, 'getScore').mockResolvedValue(10)
    render(<App />)
    await screen.findByText(/low risk/i)
    fireEvent.change(screen.getByLabelText(/dev: override score/i), { target: { value: '90' } })
    expect(await screen.findByText(/critical risk/i)).toBeInTheDocument()
  })

  it('keeps proceed immediately available for low tier', async () => {
    vi.spyOn(adapter, 'getScore').mockResolvedValue(10)
    render(<App />)
    await screen.findByText(/low risk/i)
    expect(screen.getByText('Proceed')).toBeEnabled()
  })

  it('keeps proceed immediately available for elevated tier', async () => {
    vi.spyOn(adapter, 'getScore').mockResolvedValue(30)
    render(<App />)
    await screen.findByText(/elevated risk/i)
    expect(screen.getByText('Proceed')).toBeEnabled()
  })

  it('requires an explicit confirmation before high-risk proceed is enabled', async () => {
    vi.spyOn(adapter, 'getScore').mockResolvedValue(60)
    render(<App />)
    await screen.findByText(/high risk/i)
    const proceedButton = screen.getByText('Proceed')
    expect(proceedButton).toBeDisabled()
    fireEvent.click(
      screen.getByLabelText(/i understand this destination shows strong risk signals/i),
    )
    expect(proceedButton).toBeEnabled()
  })

  it('requires typing the tier label before critical-risk proceed is enabled', async () => {
    vi.spyOn(adapter, 'getScore').mockResolvedValue(85)
    render(<App />)
    await screen.findByText(/critical risk/i)
    const proceedButton = screen.getByText('Proceed')
    const input = screen.getByLabelText(/type critical to enable proceed/i)
    expect(proceedButton).toBeDisabled()
    fireEvent.change(input, { target: { value: 'high' } })
    expect(proceedButton).toBeDisabled()
    fireEvent.change(input, { target: { value: 'critical' } })
    expect(proceedButton).toBeEnabled()
  })

  it('renders loading preview mode without calling the adapter', () => {
    const getScoreSpy = vi.spyOn(adapter, 'getScore')
    window.history.pushState(null, '', '?preview=loading')
    render(<App />)
    expect(screen.getByText(/checking destination/i)).toBeInTheDocument()
    expect(getScoreSpy).not.toHaveBeenCalled()
  })

  it('renders error preview mode', () => {
    window.history.pushState(null, '', '?preview=error')
    render(<App />)
    expect(screen.getByText(/could not reach the risk oracle/i)).toBeInTheDocument()
  })

  it('renders dev-slider preview controls', () => {
    window.history.pushState(null, '', '?preview=dev-slider')
    render(<App />)
    expect(screen.getByText(/elevated risk/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/dev: override score/i)).toBeInTheDocument()
  })

  it('renders the complete review preview without calling the adapter', () => {
    const getScoreSpy = vi.spyOn(adapter, 'getScore')
    window.history.pushState(null, '', '?preview=review')
    render(<App />)
    expect(screen.getByRole('alert')).toHaveTextContent(/account authority change/i)
    expect(screen.getByText(/operations \(in signing order\)/i)).toBeInTheDocument()
    expect(getScoreSpy).not.toHaveBeenCalled()
  })
})

describe('App in intercept mode', () => {
  const originalChrome = globalThis.chrome

  function reviewFixture(severity: 'info' | 'warning' | 'high' | 'critical') {
    return {
      severity,
      evidence: [],
      findings:
        severity === 'high'
          ? [
              {
                code: 'authority-change',
                severity: 'high' as const,
                title: 'Account authority change',
                detail: 'Signer changed.',
                operationIndex: 0,
              },
            ]
          : [],
      review: {
        schemaVersion: 1 as const,
        policyVersion: 1 as const,
        networkPassphrase: 'Custom network',
        xdrDigest: 'a'.repeat(64),
        envelope: { type: 'transaction' as const, source: 'GSOURCE', operationCount: 1 },
        operations: [],
        findings: [],
      },
    }
  }

  function mockReviewResponse(review: ReturnType<typeof reviewFixture> | undefined) {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((message, callback) => {
      if (
        (message as { type?: string }).type === 'GET_REVIEW' &&
        typeof callback === 'function'
      ) {
        callback({ review })
      }
    })
  }

  beforeEach(() => {
    vi.restoreAllMocks()
    // @ts-expect-error test-only stub of the chrome extension API
    globalThis.chrome = { runtime: { sendMessage: vi.fn() } }
  })

  afterEach(() => {
    globalThis.chrome = originalChrome
    window.history.pushState(null, '', '/')
  })

  it('requests the review with the versioned protocol and the opaque requestId only — nothing else from the URL', async () => {
    mockReviewResponse(reviewFixture('info'))
    window.history.pushState(null, '', '?mode=intercept&requestId=req-review')

    render(<App />)

    await screen.findByText(/low risk/i)
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { type: 'GET_REVIEW', protocolVersion: 1, requestId: 'req-review' },
      expect.any(Function),
    )
  })

  it('loads and renders worker-resident review data without placing it in the URL', async () => {
    mockReviewResponse(reviewFixture('high'))
    window.history.pushState(null, '', '?mode=intercept&requestId=req-review')

    const { container } = render(<App />)

    expect(await screen.findByText('Custom network')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/account authority change/i)
    expect(window.location.search).not.toContain('digest')

    // a11y check
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('fails closed — shows a reject-only state, not a reassuring low-risk default — when no review can be loaded', async () => {
    mockReviewResponse(undefined)
    window.history.pushState(null, '', '?mode=intercept&requestId=req-1')
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})

    render(<App />)

    expect(await screen.findByText(/could not be loaded for review/i)).toBeInTheDocument()
    expect(screen.queryByText(/low risk/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Proceed')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Reject'))
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'DECISION_MADE',
      protocolVersion: 1,
      requestId: 'req-1',
      decision: 'cancel',
    })
    expect(closeSpy).toHaveBeenCalled()
  })

  it('sends the decision and closes on Proceed', async () => {
    mockReviewResponse(reviewFixture('info'))
    window.history.pushState(null, '', '?mode=intercept&requestId=req-1')
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
    render(<App />)
    fireEvent.click(await screen.findByText('Proceed'))
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'DECISION_MADE',
      protocolVersion: 1,
      requestId: 'req-1',
      decision: 'proceed',
    })
    expect(closeSpy).toHaveBeenCalled()
  })

  it('blocks high-risk proceed until the user confirms', async () => {
    mockReviewResponse(reviewFixture('high'))
    window.history.pushState(null, '', '?mode=intercept&requestId=req-1')
    render(<App />)
    const proceedButton = await screen.findByText('Proceed')
    expect(proceedButton).toBeDisabled()
    fireEvent.click(
      screen.getByLabelText(/i understand this destination shows strong risk signals/i),
    )
    expect(proceedButton).toBeEnabled()
  })

  it('blocks critical-risk proceed until the user types the confirmation phrase', async () => {
    mockReviewResponse(reviewFixture('critical'))
    window.history.pushState(null, '', '?mode=intercept&requestId=req-1')
    render(<App />)
    const proceedButton = await screen.findByText('Proceed')
    const input = screen.getByLabelText(/type critical to enable proceed/i)
    expect(proceedButton).toBeDisabled()
    fireEvent.change(input, { target: { value: 'high' } })
    expect(proceedButton).toBeDisabled()
    fireEvent.change(input, { target: { value: 'critical' } })
    expect(proceedButton).toBeEnabled()
  })

  it('sends cancel and closes on Cancel', async () => {
    mockReviewResponse(reviewFixture('info'))
    window.history.pushState(null, '', '?mode=intercept&requestId=req-1')
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
    render(<App />)
    fireEvent.click(await screen.findByText('Cancel'))
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'DECISION_MADE',
      protocolVersion: 1,
      requestId: 'req-1',
      decision: 'cancel',
    })
    expect(closeSpy).toHaveBeenCalled()
  })

  it('sends cancel and closes when Escape is pressed', async () => {
    mockReviewResponse(reviewFixture('critical'))
    window.history.pushState(null, '', '?mode=intercept&requestId=req-1')
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
    render(<App />)
    await screen.findByText('Proceed')

    await userEvent.setup().keyboard('{Escape}')

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'DECISION_MADE',
      protocolVersion: 1,
      requestId: 'req-1',
      decision: 'cancel',
    })
    expect(closeSpy).toHaveBeenCalled()
  })

  it('focuses Cancel so a critical warning can be dismissed immediately', async () => {
    mockReviewResponse(reviewFixture('critical'))
    window.history.pushState(null, '', '?mode=intercept&requestId=req-1')
    render(<App />)
    await screen.findByText('Proceed')
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })
})
