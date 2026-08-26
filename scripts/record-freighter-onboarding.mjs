/**
 * ONE-OFF recording helper — not part of the test suite, not committed to
 * a permanent location. Run this manually to click through Freighter's
 * real onboarding flow with the Playwright Inspector open, then copy the
 * selectors it shows into a real onboardFreighter() helper.
 *
 * Usage:
 *   node scripts/record-freighter-onboarding.mjs
 *
 * This opens a real Chromium window with Freighter loaded. Click through
 * onboarding by hand. The Inspector window (separate from the browser
 * window) shows live Playwright code for each action you take — that's
 * what you copy from, not this file's contents.
 */
import { chromium } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const ROOT = process.cwd()
const FREIGHTER_PATH = path.join(ROOT, 'fixtures/wallets/freighter')

if (!fs.existsSync(path.join(FREIGHTER_PATH, 'manifest.json'))) {
  console.error(`No Freighter build found at ${FREIGHTER_PATH} — nothing to record against.`)
  process.exit(1)
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-record-'))

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [`--disable-extensions-except=${FREIGHTER_PATH}`, `--load-extension=${FREIGHTER_PATH}`],
})

// Find the real extension ID the same way the actual test does, rather than
// hardcoding the one we happened to observe once — IDs can differ per build.
let background = context.serviceWorkers()[0]
if (!background) background = await context.waitForEvent('serviceworker')
const extensionId = background.url().split('/')[2]
console.log(`Freighter extension ID: ${extensionId}`)

const page = await context.newPage()
await page.goto(`chrome-extension://${extensionId}/index.html#/welcome`)

console.log('')
console.log('Browser is open. Click through Freighter onboarding by hand.')
console.log('A separate Playwright Inspector window will show live code for')
console.log('each action — copy selectors from THAT window, not the terminal.')
console.log('Close the Inspector window when done to end this script.')
console.log('')

await page.pause()

await context.close()
