import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: 'input.spec.ts', timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:4184', viewport: { width: 1280, height: 900 },
    screenshot: 'only-on-failure',
    launchOptions: process.env.KSADK_TEST_CHROME_PATH ? { executablePath: process.env.KSADK_TEST_CHROME_PATH } : {},
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4184 --strictPort',
    url: 'http://127.0.0.1:4184/e2e/fixtures/input.html', reuseExistingServer: false,
  },
});
