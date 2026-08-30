import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const extensionPath = path.resolve(__dirname, '../dist')

const FREIGHTER_REQUEST_SOURCE = 'FREIGHTER_EXTERNAL_MSG_REQUEST'
const FREIGHTER_RESPONSE_SOURCE = 'FREIGHTER_EXTERNAL_MSG_RESPONSE'
const SUBMIT_TRANSACTION_TYPE = 'SUBMIT_TRANSACTION'

interface TestServer {
  url: string
  close: () => Promise<void>
}

interface ExtensionHarness {
  context: BrowserContext
  page: Page
  close: () => Promise<void>
}

function buildPaymentXdr() {
  const source = Keypair.random().publicKey()
  const destination = Keypair.random().publicKey()
  const account = new Account(source, '0')

  return new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination, asset: Asset.native(), amount: '10' }))
    .setTimeout(30)
    .build()
    .toXDR()
}

function buildSemanticReviewXdr() {
  const source = Keypair.random().publicKey()
  const destination = Keypair.random().publicKey()
  const account = new Account(source, '0')

  return new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination, asset: Asset.native(), amount: '10' }))
    .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: destination, weight: 1 } }))
    .addMemo(Memo.text('review-invoice-42'))
    .setTimeout(30)
    .build()
    .toXDR()
}

async function startTestServer(): Promise<TestServer> {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(
      `<!doctype html><html><head><title>Freighter Harness</title></head><body data-route="${
        request.url ?? '/'
      }"></body></html>`,
    )
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

async function launchExtension(url: string): Promise<ExtensionHarness> {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'grydlock-e2e-'))
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox',
    ],
  })
  const page = context.pages()[0] ?? (await context.newPage())
  await page.goto(url)

  return {
    context,
    page,
    close: () => context.close(),
  }
}

async function submitTransaction(page: Page, xdr: string, messageId = 38) {
  return page.evaluate(
    ({
      freighterRequestSource,
      freighterResponseSource,
      submitTransactionType,
      transactionXdr,
      requestMessageId,
    }) =>
      new Promise<{
        freighterSawReviewedRequest: boolean
        response: Record<string, unknown>
      }>((resolve) => {
        let freighterSawReviewedRequest = false

        window.addEventListener('message', (event) => {
          if (event.source !== window) return
          const data = event.data as Record<string, unknown>

          if (
            data.source === freighterRequestSource &&
            data.type === submitTransactionType &&
            data.messageId === requestMessageId &&
            data.__grydlockReviewed === true
          ) {
            freighterSawReviewedRequest = true
            window.postMessage(
              {
                source: freighterResponseSource,
                messageId: requestMessageId,
                signedTransaction: 'signed-by-freighter',
                signerAddress: 'GBROWSERTESTSIGNER',
              },
              window.location.origin,
            )
          }

          // messageId disambiguates concurrent submitTransaction calls sharing one page:
          // each call's own listener must only resolve on ITS OWN request's response.
          if (data.source === freighterResponseSource && data.messageId === requestMessageId) {
            resolve({
              freighterSawReviewedRequest,
              response: data,
            })
          }
        })

        window.postMessage(
          {
            source: freighterRequestSource,
            messageId: requestMessageId,
            type: submitTransactionType,
            transactionXdr,
            networkPassphrase: 'Test SDF Network ; September 2015',
          },
          window.location.origin,
        )
      }),
    {
      freighterRequestSource: FREIGHTER_REQUEST_SOURCE,
      freighterResponseSource: FREIGHTER_RESPONSE_SOURCE,
      submitTransactionType: SUBMIT_TRANSACTION_TYPE,
      transactionXdr: xdr,
      requestMessageId: messageId,
    },
  )
}

async function openToolbar(context: BrowserContext): Promise<Page> {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  const workerUrl = new URL(worker.url())
  const toolbar = await context.newPage()
  await toolbar.goto(`${workerUrl.protocol}//${workerUrl.host}/src/popup/index.html`)
  return toolbar
}

async function makeDecision(popupPromise: Promise<Page>, label: 'Proceed' | 'Cancel') {
  const popup = await popupPromise
  await expect(popup.getByRole('heading', { name: /risk/i })).toBeVisible()
  if (label === 'Proceed') {
    const highConfirmation = popup.getByLabel(/strong risk signals/i)
    if (await highConfirmation.isVisible().catch(() => false)) {
      await highConfirmation.check()
    }

    const criticalConfirmation = popup.getByLabel(/type critical to enable proceed/i)
    if (await criticalConfirmation.isVisible().catch(() => false)) {
      await criticalConfirmation.fill('CRITICAL')
    }
  }
  await popup.getByRole('button', { name: label }).click()
}

test.describe('Freighter signTransaction interception', () => {
  let server: TestServer | undefined
  let harness: ExtensionHarness | undefined

  test.beforeEach(async () => {
    server = await startTestServer()
    harness = await launchExtension(server.url)
  })

  test.afterEach(async () => {
    await harness?.close()
    await server?.close()
  })

  test('re-posts the reviewed request to Freighter after proceed', async () => {
    const popupPromise = harness!.context.waitForEvent('page')
    const responsePromise = submitTransaction(harness!.page, buildPaymentXdr())

    await makeDecision(popupPromise, 'Proceed')

    await expect(responsePromise).resolves.toMatchObject({
      freighterSawReviewedRequest: true,
      response: {
        source: FREIGHTER_RESPONSE_SOURCE,
        messageId: 38,
        signedTransaction: 'signed-by-freighter',
      },
    })
  })

  test('synthesizes a Freighter rejection without forwarding after cancel', async () => {
    const popupPromise = harness!.context.waitForEvent('page')
    const responsePromise = submitTransaction(harness!.page, buildPaymentXdr())

    await makeDecision(popupPromise, 'Cancel')

    await expect(responsePromise).resolves.toMatchObject({
      freighterSawReviewedRequest: false,
      response: {
        source: FREIGHTER_RESPONSE_SOURCE,
        signedTransaction: '',
        apiError: {
          code: -4,
        },
      },
    })
  })

  test('renders the full semantic review in the interception popup', async () => {
    const popupPromise = harness!.context.waitForEvent('page')
    const responsePromise = submitTransaction(harness!.page, buildSemanticReviewXdr())
    const popup = await popupPromise

    await expect(popup.locator('.review-summary p').filter({ hasText: 'Network:' })).toContainText(
      Networks.TESTNET,
    )
    await expect(popup.locator('.review-summary p').filter({ hasText: 'Envelope:' })).toContainText(
      '2 operations',
    )
    await expect(
      popup.locator('.review-summary p').filter({ hasText: 'Memo (text):' }),
    ).toContainText('review-invoice-42')
    await expect(popup.getByRole('alert', { name: 'Transaction review findings' })).toContainText(
      'Account authority change',
    )
    await expect(popup.getByText(/#1 Payment — understood/)).toBeVisible()
    await expect(popup.getByText(/#2 Change account options — understood/)).toBeVisible()

    await makeDecision(Promise.resolve(popup), 'Cancel')
    await expect(responsePromise).resolves.toMatchObject({
      freighterSawReviewedRequest: false,
      response: { source: FREIGHTER_RESPONSE_SOURCE },
    })
  })

  test('reports protected only after the injected MAIN, bridge, and worker handshake completes', async () => {
    const toolbar = await openToolbar(harness!.context)
    // A toolbar popup is not a tab in normal use. Focus the dApp again so the popup's
    // active-tab lookup exercises the same target a user would see under the toolbar icon.
    await harness!.page.bringToFront()
    await toolbar.getByRole('button', { name: 'Refresh status' }).click()

    await expect(toolbar.getByRole('heading', { name: /protection path checked/i })).toBeVisible({
      timeout: 10_000,
    })
    await toolbar.close()
  })

  test('re-establishes protection after reload and same-origin navigation', async () => {
    const toolbar = await openToolbar(harness!.context)
    await harness!.page.bringToFront()
    await toolbar.getByRole('button', { name: 'Refresh status' }).click()
    await expect(toolbar.getByRole('heading', { name: /protection path checked/i })).toBeVisible({
      timeout: 10_000,
    })

    await harness!.page.reload()
    await harness!.page.goto(`${server!.url}/next`)
    await harness!.page.bringToFront()
    await toolbar.getByRole('button', { name: 'Refresh status' }).click()
    await expect(toolbar.getByRole('heading', { name: /protection path checked/i })).toBeVisible({
      timeout: 10_000,
    })
    await toolbar.close()
  })

  test('closing the review popup settles the request as cancelled instead of hanging the dApp', async () => {
    const popupPromise = harness!.context.waitForEvent('page')
    const responsePromise = submitTransaction(harness!.page, buildPaymentXdr())

    const popup = await popupPromise
    await expect(popup.getByRole('heading', { name: /risk/i })).toBeVisible()
    await popup.close()

    await expect(responsePromise).resolves.toMatchObject({
      freighterSawReviewedRequest: false,
      response: {
        source: FREIGHTER_RESPONSE_SOURCE,
        signedTransaction: '',
        apiError: { code: -4 },
      },
    })
  })

  test('two concurrent requests from the same page open two popups and settle independently, without colliding', async () => {
    const firstPopupPromise = harness!.context.waitForEvent('page')
    const firstResponsePromise = submitTransaction(harness!.page, buildPaymentXdr(), 101)
    const firstPopup = await firstPopupPromise
    await expect(firstPopup.getByRole('heading', { name: /risk/i })).toBeVisible()

    const secondPopupPromise = harness!.context.waitForEvent('page')
    const secondResponsePromise = submitTransaction(harness!.page, buildPaymentXdr(), 102)
    const secondPopup = await secondPopupPromise
    await expect(secondPopup.getByRole('heading', { name: /risk/i })).toBeVisible()

    expect(firstPopup).not.toBe(secondPopup)

    // Decide them in reverse order: if either request's state collided with the
    // other's (e.g. sharing one map entry), this would resolve the wrong promise
    // with the wrong outcome instead of each settling independently.
    await makeDecision(Promise.resolve(secondPopup), 'Cancel')
    await makeDecision(Promise.resolve(firstPopup), 'Proceed')

    await expect(firstResponsePromise).resolves.toMatchObject({
      freighterSawReviewedRequest: true,
      response: { messageId: 101, signedTransaction: 'signed-by-freighter' },
    })
    await expect(secondResponsePromise).resolves.toMatchObject({
      freighterSawReviewedRequest: false,
      response: { messageId: 102, signedTransaction: '' },
    })
  })

  test('surfaces an incompatible protocol observed in a child frame', async () => {
    const toolbar = await openToolbar(harness!.context)
    const childFrame = harness!.page.waitForEvent('frameattached')
    await harness!.page.evaluate((frameUrl) => {
      const iframe = document.createElement('iframe')
      iframe.src = frameUrl
      document.body.append(iframe)
    }, `${server!.url}/frame`)
    const child = await childFrame
    await child.waitForLoadState('domcontentloaded')
    await child.evaluate(() => {
      window.postMessage(
        {
          source: 'FREIGHTER_EXTERNAL_MSG_REQUEST',
          type: 'UNSUPPORTED_FREIGHTER_OPERATION',
        },
        window.location.origin,
      )
    })

    await harness!.page.bringToFront()
    await toolbar.getByRole('button', { name: 'Refresh status' }).click()
    await expect(
      toolbar.getByRole('heading', { name: /wallet protocol is incompatible/i }),
    ).toBeVisible({
      timeout: 10_000,
    })
    await toolbar.close()
  })
})
