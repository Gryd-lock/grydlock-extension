import type { Locator, Page } from '@playwright/test'

/**
 * Clicks a popup button that closes its own window (Proceed/Cancel call
 * window.close()). Playwright can report "Target page ... has been closed"
 * while finishing such a click; that close is the expected result, not a
 * failure, so wait for it explicitly instead.
 */
export async function clickAndClose(page: Page, button: Locator): Promise<void> {
  const closed = page.waitForEvent('close')
  await button.click().catch((error: Error) => {
    if (!/has been closed/.test(error.message)) throw error
  })
  await closed
}
