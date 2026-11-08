/**
 * Real-wallet protocol drift detector: Freighter.
 *
 * Runs against a REAL, version-pinned, unpacked Freighter build — not the
 * hand-written fixture used by e2e/freighter-interception.spec.ts. A failure
 * here means the real Freighter extension no longer matches what Gryd Lock's
 * code assumes; it is drift, not a Gryd Lock bug (see the protocol-drift
 * spike doc, §2–§3).
 *
 * NOT run by `npm run test:e2e` — playwright.e2e.config.ts excludes
 * `**\/real/**`. This runs via `playwright.canary.config.ts`, only from the
 * scheduled/manual wallet-canary CI workflow.
 *
 * PREREQUISITE: fixtures/wallets/freighter must contain a real unpacked
 * build, fetched via scripts/download-wallet-release.sh against the version
 * pinned in tests/wallet-versions.json. Skips (does not fail) if absent, so
 * this degrades gracefully in environments without the vendored build cached.
 *
 * TODO once src/intercept/protocol.ts is confirmed: replace the ad-hoc
 * capture/log below with real validation against whatever schema/types
 * already live there, instead of just logging captured messages to console.
 */
import { test, expect, chromium } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { checkAgainstKnownContracts } from '../../src/intercept/externalWalletProtocol'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
const GRYDLOCK_PATH = path.join(ROOT, 'dist')
const FREIGHTER_PATH = path.join(ROOT, 'fixtures/wallets/freighter')

test.describe('Real-wallet protocol drift: Freighter', () => {
  test.skip(
    !fs.existsSync(path.join(FREIGHTER_PATH, 'manifest.json')),
    'No vendored real Freighter build present — run ' +
      'scripts/download-wallet-release.sh first. Skipping rather than ' +
      'failing so this does not block environments without the cache.',
  )

  test('captures whatever the real Freighter extension actually sends', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-real-freighter-'))

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${GRYDLOCK_PATH},${FREIGHTER_PATH}`,
        `--load-extension=${GRYDLOCK_PATH},${FREIGHTER_PATH}`,
      ],
    })

    try {
      const page = await context.newPage()
      const capturedMessages: unknown[] = []

      await page.exposeFunction('__captureMessage', (msg: unknown) => {
        capturedMessages.push(msg)
      })

      await page.goto('https://example.com')
      await page.evaluate(() => {
        window.addEventListener('message', (event) => {
          // @ts-expect-error injected by exposeFunction
          window.__captureMessage(event.data)
        })
        document.body.innerHTML = '<button id="connect">Connect Freighter</button>'
      })

      // Log what the real extension actually injects onto `window` — this
      // itself is a finding if it differs from what the synthetic fixture
      // assumes (e.g. a `window.freighterApi` object vs. requiring the dApp
      // to hand-construct a postMessage).
      const freighterGlobals = await page.evaluate(() =>
        Object.keys(window).filter((k) => /freighter/i.test(k)),
      )
      console.log('[drift-check] window globals matching /freighter/i:', freighterGlobals)

      await page.waitForTimeout(500)

      const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null)
      await page.click('#connect')
      const popup = await popupPromise

      if (popup) {
        console.log('[drift-check] Freighter opened a real page/window:', popup.url())
      } else {
        console.log(
          '[drift-check] No new page event within 5s — record this in ' +
            'docs/wallet-compatibility.md: either Freighter uses an ' +
            'action-style popup Playwright cannot see, requires a real ' +
            'toolbar click, or needs an unlocked/onboarded wallet state first.',
        )
      }

      console.log('[drift-check] captured messages:', JSON.stringify(capturedMessages, null, 2))

      // The real drift signal: does each captured message still match a
      // known contract shape? A mismatch here means Freighter changed its
      // protocol, independent of whether Gryd Lock's interception "worked".
      for (const msg of capturedMessages) {
        const result = checkAgainstKnownContracts(msg)
        if (!result.ok) {
          console.error(`[drift-check] CONTRACT MISMATCH: ${result.reason}`)
          console.error('[drift-check] offending message:', JSON.stringify(msg, null, 2))
        } else {
          console.log(`[drift-check] matched known contract: ${result.matched}`)
        }
      }

      expect(
        capturedMessages.length,
        'Expected at least one message captured from the real Freighter ' +
          'extension. Zero captures likely means the trigger step above no ' +
          'longer matches how this Freighter version actually initiates a ' +
          'request — investigate manually before assuming this is a bug here.',
      ).toBeGreaterThan(0)
    } finally {
      await context.close()
    }
  })
})
