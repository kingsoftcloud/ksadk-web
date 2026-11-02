import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: 'a2ui-renderer.spec.ts', timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:4186', screenshot: 'only-on-failure',
    launchOptions: process.env.KSADK_TEST_CHROME_PATH ? { executablePath: process.env.KSADK_TEST_CHROME_PATH } : {},
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4186 --strictPort',
    url: 'http://127.0.0.1:4186/e2e/fixtures/a2ui-renderer.html', reuseExistingServer: false,
  },
});
