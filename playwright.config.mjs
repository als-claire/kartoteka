import { defineConfig, devices } from '@playwright/test';

// Тесты работают с сайтом, собранным из tests/fixtures (npm test собирает его сам).
export default defineConfig({
  testDir: 'tests',
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  globalSetup: './tests/global-setup.mjs',
  use: { baseURL: 'http://localhost:4175/' },
  webServer: {
    command: 'node build/serve.mjs _site-test 4175',
    url: 'http://localhost:4175/',
    reuseExistingServer: false,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /mobile/ },
    { name: 'phone', use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true }, testMatch: /mobile/ },
  ],
});
