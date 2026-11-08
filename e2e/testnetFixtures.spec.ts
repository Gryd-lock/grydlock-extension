/**
 * End-to-end: built extension + local test dApp (demo/) + grydlock-testkit
 * testnet XDR. Verifies the warning tier the user actually sees for each
 * score source, and that Proceed forwards / Cancel rejects at the
 * Freighter postMessage boundary.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test'
import { startDemoServer } from '../demo/server.mjs'
import { clickAndClose } from './clickAndClose'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const extensionPath = path.resolve(__dirname, '../dist')
const MAINNET = 'Public Global Stellar Network ; September 2015'

type Fixture = 'payment' | 'path_payment' | 'fee_bump_payment'
type Outcome =
  | { fixture: string; outcome: 'forwarded-to-wallet'; signedTransaction: string }
  | { fixture: string; outcome: 'rejected'; code: number }

let server: { url: string; close: () => Promise<void> }
let context: BrowserContext
let dapp: Page
let extensionOrigin: string

test.beforeEach(async () => {
  server = await startDemoServer({ port: 0 })
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'grydlock-e2e-fixtures-'))
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox',
    ],
  })
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  const workerUrl = new URL(worker.url())
  // URL.origin is "null" for chrome-extension:// URLs.
  extensionOrigin = `${workerUrl.protocol}//${workerUrl.host}`
  dapp = context.pages()[0] ?? (await context.newPage())
  await dapp.goto(server.url)
})

test.afterEach(async () => {
  await context?.close()
  await server?.close()
})

/** Uses the real options page, exactly as a user would. */
async function chooseScoreSource(label: RegExp) {
  const options = await context.newPage()
  await options.goto(`${extensionOrigin}/src/history/index.html`)
  await options.getByLabel(label).check()
  await options.getByRole('button', { name: 'Save' }).click()
  await expect(options.getByRole('status').filter({ hasText: /saved/i })).toBeVisible()
  await options.close()
  await dapp.bringToFront()
}

function send(fixture: Fixture, networkPassphrase?: string) {
  const popup = context.waitForEvent('page')
  const outcome = dapp.evaluate(
    ([name, passphrase]) =>
      (
        window as unknown as {
          grydlockDemo: { submit: (f: string, p?: string) => Promise<unknown> }
        }
      ).grydlockDemo.submit(name, passphrase ?? undefined),
    [fixture, networkPassphrase ?? null] as const,
  ) as Promise<Outcome>
  return { popup, outcome }
}

test('default (score source off): testkit payment shows Unknown, never a fabricated tier', async () => {
  const { popup, outcome } = send('payment')
  const review = await popup

  await expect(review.getByRole('heading', { name: 'Unknown risk' })).toBeVisible()
  await expect(review.getByLabel('Destination assessment')).toContainText(
    'GCRNKXJJLZNDLK2EWPX25JISTORCXCF2HYUXMYKF7XWKHMEOHCXVGP4J',
  )
  await expect(review.getByLabel('Destination assessment')).toContainText(
    /destination scoring is off/i,
  )
  await expect(review.getByText(/^Score:/)).toHaveCount(0)

  await clickAndClose(review, review.getByRole('button', { name: 'Proceed' }))
  await expect(outcome).resolves.toEqual({
    fixture: 'payment',
    outcome: 'forwarded-to-wallet',
    signedTransaction: 'demo-wallet-would-sign-here',
  })
})

test.describe('testkit fixtures score source', () => {
  test.beforeEach(async () => {
    await chooseScoreSource(/testkit fixtures \(testnet only\)/i)
  })

  test('payment to suspicious_wallet_1 is High; Proceed requires confirmation then forwards', async () => {
    const { popup, outcome } = send('payment')
    const review = await popup

    await expect(review.getByRole('heading', { name: 'High risk' })).toBeVisible()
    await expect(review.getByLabel('Destination assessment')).toContainText(
      'Score 55 / 100 (testkit fixtures)',
    )
    const proceed = review.getByRole('button', { name: 'Proceed' })
    await expect(proceed).toBeDisabled()
    await review.getByLabel(/strong risk signals/i).check()
    await clickAndClose(review, proceed)

    await expect(outcome).resolves.toMatchObject({ outcome: 'forwarded-to-wallet' })
    await expect(dapp.locator('#result')).toContainText('forwarded-to-wallet')
  })

  test('path payment to malicious_wallet_1 is Critical; Cancel rejects without reaching the wallet', async () => {
    const { popup, outcome } = send('path_payment')
    const review = await popup

    await expect(review.getByRole('heading', { name: 'Critical risk' })).toBeVisible()
    await expect(review.getByLabel('Destination assessment')).toContainText(
      'Score 92 / 100 (testkit fixtures)',
    )
    await expect(review.getByRole('button', { name: 'Proceed' })).toBeDisabled()
    await clickAndClose(review, review.getByRole('button', { name: 'Cancel' }))

    // -4 is Freighter's user-rejection code; the stand-in wallet never saw the request.
    await expect(outcome).resolves.toEqual({ fixture: 'path_payment', outcome: 'rejected', code: -4 })
  })

  test('fee-bump envelope is scored on the inner payment destination', async () => {
    const { popup, outcome } = send('fee_bump_payment')
    const review = await popup
    await expect(review.getByRole('heading', { name: 'High risk' })).toBeVisible()
    await clickAndClose(review, review.getByRole('button', { name: 'Cancel' }))
    await expect(outcome).resolves.toMatchObject({ outcome: 'rejected' })
  })

  test('fixture scores are refused for a mainnet passphrase', async () => {
    const { popup, outcome } = send('payment', MAINNET)
    const review = await popup

    await expect(review.getByRole('heading', { name: 'Unknown risk' })).toBeVisible()
    await expect(review.getByText(MAINNET).first()).toBeVisible()
    await expect(review.getByRole('alert', { name: 'Transaction review findings' })).toContainText(
      'Testkit fixtures not used on this network',
    )
    await expect(review.getByText(/Score 55/)).toHaveCount(0)
    await clickAndClose(review, review.getByRole('button', { name: 'Cancel' }))
    await expect(outcome).resolves.toMatchObject({ outcome: 'rejected' })
  })
})
