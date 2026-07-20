import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe, toHaveNoViolations } from 'jest-axe'
import App from './App'
import * as adapter from '../adapter/oracleAdapter'

expect.extend(toHaveNoViolations)

describe('App', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
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
    expect(screen.getByText(/critical risk/i).closest('.popup')).toHaveAttribute('data-tier', 'critical')
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
    fireEvent.click(screen.getByLabelText(/i understand this destination shows strong risk signals/i))
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
})

describe('App in intercept mode', () => {
  const originalChrome = globalThis.chrome

  beforeEach(() => {
    vi.restoreAllMocks()
    // @ts-expect-error test-only stub of the chrome extension API
    globalThis.chrome = { runtime: { sendMessage: vi.fn() } }
  })

  afterEach(() => {
    globalThis.chrome = originalChrome
    window.history.pushState(null, '', '/')
  })

  it('renders the tier from URL params without calling the adapter', async () => {
    const getScoreSpy = vi.spyOn(adapter, 'getScore')
    window.history.pushState(
      null,
      '',
      '?mode=intercept&requestId=req-1&destination=GDEST&score=85',
    )
    const { container } = render(<App />)
    expect(screen.getByText(/critical risk/i)).toBeInTheDocument()
    expect(screen.getByText('GDEST')).toBeInTheDocument()
    expect(screen.getByText(/critical risk/i).closest('.popup')).toHaveAttribute('data-tier', 'critical')
    expect(getScoreSpy).not.toHaveBeenCalled()
    
    // a11y check
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('sends the decision and closes on Proceed', () => {
    window.history.pushState(
      null,
      '',
      '?mode=intercept&requestId=req-1&destination=GDEST&score=10',
    )
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
    render(<App />)
    fireEvent.click(screen.getByText('Proceed'))
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'DECISION_MADE',
      requestId: 'req-1',
      decision: 'proceed',
    })
    expect(closeSpy).toHaveBeenCalled()
  })

  it('blocks high-risk proceed until the user confirms', () => {
    window.history.pushState(
      null,
      '',
      '?mode=intercept&requestId=req-1&destination=GDEST&score=60',
    )
    render(<App />)
    const proceedButton = screen.getByText('Proceed')
    expect(proceedButton).toBeDisabled()
    fireEvent.click(screen.getByLabelText(/i understand this destination shows strong risk signals/i))
    expect(proceedButton).toBeEnabled()
  })

  it('blocks critical-risk proceed until the user types the confirmation phrase', () => {
    window.history.pushState(
      null,
      '',
      '?mode=intercept&requestId=req-1&destination=GDEST&score=85',
    )
    render(<App />)
    const proceedButton = screen.getByText('Proceed')
    expect(proceedButton).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/type critical to enable proceed/i), {
      target: { value: 'critical' },
    })
    expect(proceedButton).toBeEnabled()
  })

  it('sends cancel and closes on Cancel', () => {
    window.history.pushState(
      null,
      '',
      '?mode=intercept&requestId=req-1&destination=GDEST&score=10',
    )
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
    render(<App />)
    fireEvent.click(screen.getByText('Cancel'))
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'DECISION_MADE',
      requestId: 'req-1',
      decision: 'cancel',
    })
    expect(closeSpy).toHaveBeenCalled()
  })

  it('sends cancel and closes when Escape is pressed', async () => {
    window.history.pushState(null, '', '?mode=intercept&requestId=req-1&destination=GDEST&score=85')
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
    render(<App />)

    await userEvent.setup().keyboard('{Escape}')

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'DECISION_MADE',
      requestId: 'req-1',
      decision: 'cancel',
    })
    expect(closeSpy).toHaveBeenCalled()
  })

  it('focuses Cancel so a critical warning can be dismissed immediately', () => {
    window.history.pushState(null, '', '?mode=intercept&requestId=req-1&destination=GDEST&score=85')
    render(<App />)
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })
})
