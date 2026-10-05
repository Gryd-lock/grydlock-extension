import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e/real',
  fullyParallel: false,
  timeout: 60_000,
  // Real-wallet boots (two extensions, real network calls from the wallet
  // itself) are slower and less predictable than the synthetic e2e suite —
  // give this more headroom than playwright.e2e.config.ts's default.
  use: {
    browserName: 'chromium',
    headless: false,
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium' }],
})
