import { defineConfig, devices } from '@playwright/test'

const localChromeConfig = process.env.CI
  ? {}
  : {
      channel: 'chrome' as const,
    }

export default defineConfig({
  testDir: './tests/visual',
  fullyParallel: true,
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}{ext}',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    headless: true,
    viewport: { width: 320, height: 420 },
    screenshot: 'only-on-failure',
    ...localChromeConfig,
  },
  webServer: {
    command: 'npm run visual:serve',
    url: 'http://127.0.0.1:4173/src/popup/index.html',
    reuseExistingServer: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
