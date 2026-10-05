import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testIgnore: '**/real/**',
  fullyParallel: false,
  use: {
    browserName: 'chromium',
    headless: false,
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium' }],
})
