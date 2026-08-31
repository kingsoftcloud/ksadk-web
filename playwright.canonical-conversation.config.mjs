import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'canonical-conversation.spec.ts',
  // The deterministic HTTP/SSE fixture models one durable session and one
  // first-wins interaction ledger. Keep retries/repeats serialized so test
  // cases cannot reset the same server truth concurrently.
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://127.0.0.1:4175',
    viewport: { width: 1280, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node e2e/fixtures/canonical-conversation-server.mjs',
      url: 'http://127.0.0.1:4182/__fixture/health',
      reuseExistingServer: false,
    },
    {
      command: 'npm run dev -- --config vite.canonical-conversation.config.mjs --host 127.0.0.1 --port 4175 --strictPort',
      url: 'http://127.0.0.1:4175',
      reuseExistingServer: false,
    },
  ],
});
