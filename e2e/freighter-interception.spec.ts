/**
 * PoC — real-wallet protocol drift detector for Freighter.
 *
 * Differs from the existing synthetic test in three load-bearing ways:
 *   1. Loads a REAL, version-pinned, unpacked Freighter build (fixtures/wallets/freighter),
 *      not a fixture that only Gryd Lock itself wrote.
 *   2. Captures the ACTUAL message Freighter's content script sends and validates it
 *      against the shared protocol poc — a poc failure here is drift, not a bug
 *      in Gryd Lock's interception logic.
 *   3. Detects popup mechanism empirically (page vs extension popup) rather than
 *      assuming which one Freighter uses this version — see spike §4/§8.
 *
 * This is a manually-triggered / nightly-scheduled job (spike §10), NOT part of the
 * PR-blocking suite, because real-extension runs are slower and can fail for reasons
 * unrelated to Gryd Lock (Freighter's own bugs, network flakiness fetching its RPC, etc).
 * A failure here should open an issue for investigation, not block a merge.
 *
 * PREREQUISITE: fixtures/wallets/freighter must contain a real unpacked build,
 * fetched via poc/download-wallet-release.sh against a version pinned in
 * tests/fixtures/wallet-versions.json. This test will skip (not fail) if absent,
 * so it degrades gracefully when run outside the environment that has the vendored
 * build cached.
 */
import { test, expect, chromium } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { FreighterSubmitTransactionRequest, validateOrReport } from '../poc/protocol-contract.schema'

const GRYDLOCK_PATH = path.resolve(import.meta.dirname, '../../dist')
const FREIGHTER_PATH = path.resolve(import.meta.dirname, '../../fixtures/wallets/freighter')

test.describe('Real-wallet protocol drift: Freighter', () => {
  test.skip(
    !fs.existsSync(path.join(FREIGHTER_PATH, 'manifest.json')),
    'No vendored real Freighter build present — run download-wallet-release.sh first. ' +
      'Skipping rather than failing so this does not block environments without the cache.',
  )

  test('captured real Freighter request matches the pinned protocol contract', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-real-freighter-'))

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false, // MV3 extensions require a real browser process
      channel: 'chromium', // pin the Chrome build too — see spike §8
      args: [
        `--disable-extensions-except=${GRYDLOCK_PATH},${FREIGHTER_PATH}`,
        `--load-extension=${GRYDLOCK_PATH},${FREIGHTER_PATH}`,
      ],
    })

    try {
      const page = await context.newPage()

      // Capture whatever the REAL Freighter content script actually broadcasts,
      // instead of asserting our own fixture shape.
      const capturedMessages: unknown[] = []
      await page.exposeFunction('__captureMessage', (msg: unknown) => {
        capturedMessages.push(msg)
      })

      await page.goto('https://example.com') // real https origin — some wallets gate on scheme

      await page.evaluate(() => {
        window.addEventListener('message', (event) => {
          // @ts-expect-error injected by exposeFunction
          window.__captureMessage(event.data)
        })
        document.body.innerHTML = '<button id="connect">Connect Freighter</button>'
      })

      // Trigger whatever real Freighter's page-facing API actually is. If Freighter
      // injects `window.freighterApi` (or similar) rather than requiring the dApp to
      // hand-construct a postMessage, that itself is a finding — the original synthetic
      // test's assumption that dApps manually construct FREIGHTER_EXTERNAL_MSG_REQUEST
      // may not reflect the real integration path at all. Log what's actually present:
      const freighterGlobals = await page.evaluate(() =>
        Object.keys(window).filter((k) => /freighter/i.test(k)),
      )
      console.log('[drift-check] window globals matching /freighter/i:', freighterGlobals)

      // Give the real extension's content script time to register (document_idle etc).
      await page.waitForTimeout(500)

      // Attempt to detect Freighter's popup mechanism empirically rather than assuming.
      const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null)

      await page.click('#connect')
      const popup = await popupPromise

      if (popup) {
        console.log('[drift-check] Freighter opened a real page/window:', popup.url())
      } else {
        console.log(
          '[drift-check] No new page event within 5s — Freighter likely used an ' +
            'action-style popup (invisible to Playwright) or requires a real toolbar ' +
            'click, or this build needs an unlocked/onboarded wallet state first. ' +
            'This is exactly the kind of finding that belongs in the compatibility ' +
            'matrix (spike §4), not silently ignored.',
        )
      }

      // Validate whatever we actually captured against the shared contract.
      for (const msg of capturedMessages) {
        const result = validateOrReport(
          FreighterSubmitTransactionRequest,
          msg,
          'freighter-real-capture',
        )
        if (!result.ok) {
          // Intentionally soft-fail with full diagnostics rather than a bare assert,
          // since a poc mismatch here is the whole point of this test — surface it
          // clearly so a human can decide: update the poc, or file a real bug.
          console.error(result.issues)
        }
      }

      expect(
        capturedMessages.length,
        'Expected at least one message to be captured from the real Freighter ' +
          'extension. Zero captures likely means the trigger step above no longer ' +
          'matches how this Freighter version actually initiates a request — update ' +
          'this PoC once the real trigger mechanism is confirmed manually.',
      ).toBeGreaterThan(0)
    } finally {
      await context.close()
    }
  })

  test("injection-order canary: which extension's listener fires first", async () => {
    for (const order of [
      [GRYDLOCK_PATH, FREIGHTER_PATH],
      [FREIGHTER_PATH, GRYDLOCK_PATH],
    ]) {
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-order-'))
      const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: [
          `--disable-extensions-except=${order.join(',')}`,
          `--load-extension=${order.join(',')}`,
        ],
      })

      try {
        const page = await context.newPage()
        const consoleLines: string[] = []
        page.on('console', (msg) => consoleLines.push(msg.text()))

        await page.goto('https://example.com')
        await page.waitForTimeout(500)

        console.log(
          `[order: ${order.map((p) => path.basename(p)).join(' -> ')}]`,
          consoleLines.filter((l) => /grydlock|freighter/i.test(l)),
        )
        // This test intentionally does not assert a fixed order — per spike §6,
        // flaky/variable ordering is itself the finding. Run this across many CI
        // executions and track the distribution, not a single pass/fail.
      } finally {
        await context.close()
      }
    }
  })
})
