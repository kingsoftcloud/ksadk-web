import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'history-contract.spec.ts',
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: { baseURL: 'http://127.0.0.1:4187', viewport: { width: 1280, height: 900 } },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4187 --strictPort',
    url: 'http://127.0.0.1:4187/e2e/fixtures/history-contract.html',
    reuseExistingServer: false,
  },
});
