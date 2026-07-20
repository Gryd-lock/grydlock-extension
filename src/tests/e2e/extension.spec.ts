import { test, expect } from '@playwright/test';

test('extension loads and basic functionality', async ({ page }) => {
  // Open a blank page (extension will be loaded via Playwright config)
  await page.goto('about:blank');
  // Simple check that the extension background script is active
  const isActive = await page.evaluate(() => !!chrome?.runtime?.id);
  expect(isActive).toBeTruthy();
});
