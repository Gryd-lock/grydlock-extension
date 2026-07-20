import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk'
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

async function startTestServer(): Promise<TestServer> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><html><head><title>Freighter Harness</title></head><body></body></html>')
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

async function submitTransaction(page: Page, xdr: string) {
  return page.evaluate(
    ({ freighterRequestSource, freighterResponseSource, submitTransactionType, transactionXdr }) =>
      new Promise<{
        freighterSawReviewedRequest: boolean
        response: Record<string, unknown>
      }>((resolve) => {
        const messageId = 38
        let freighterSawReviewedRequest = false

        window.addEventListener('message', (event) => {
          if (event.source !== window) return
          const data = event.data as Record<string, unknown>

          if (
            data.source === freighterRequestSource &&
            data.type === submitTransactionType &&
            data.messageId === messageId &&
            data.__grydlockReviewed === true
          ) {
            freighterSawReviewedRequest = true
            window.postMessage(
              {
                source: freighterResponseSource,
                messageId,
                signedTransaction: 'signed-by-freighter',
                signerAddress: 'GBROWSERTESTSIGNER',
              },
              window.location.origin,
            )
          }

          if (data.source === freighterResponseSource) {
            resolve({
              freighterSawReviewedRequest,
              response: data,
            })
          }
        })

        window.postMessage(
          {
            source: freighterRequestSource,
            messageId,
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
    },
  )
}

async function makeDecision(popupPromise: Promise<Page>, label: 'Proceed' | 'Cancel') {
  const popup = await popupPromise
  await expect(popup.getByRole('heading', { name: /risk/i })).toBeVisible()
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
})
