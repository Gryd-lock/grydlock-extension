import { defineConfig, devices } from '@playwright/test';
import path from 'path';

export default defineConfig({
  timeout: 60000,
  use: {
    headless: false,
    launchOptions: {
      args: [
        `--disable-extensions-except=${path.join(__dirname, 'dist')}`,
        `--load-extension=${path.join(__dirname, 'dist')}`
      ]
    }
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'chrome',
      use: { channel: 'chrome' }
    },
    {
      name: 'edge',
      use: { channel: 'msedge' }
    }
  ]
});
