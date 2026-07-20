import { expect, test } from '@playwright/test'

const cases = [
  { name: 'loading', query: '?preview=loading' },
  { name: 'error', query: '?preview=error' },
  { name: 'low', query: '?preview=low' },
  { name: 'elevated', query: '?preview=elevated' },
  { name: 'high', query: '?preview=high' },
  { name: 'critical', query: '?preview=critical' },
  { name: 'dev-slider', query: '?preview=dev-slider' },
] as const

for (const popupCase of cases) {
  test(`popup visual regression: ${popupCase.name}`, async ({ page }) => {
    await page.goto(`/src/popup/index.html${popupCase.query}`)
    await page.locator('.popup').waitFor()
    await expect(page.locator('.popup')).toHaveScreenshot(`${popupCase.name}.png`)
  })
}
