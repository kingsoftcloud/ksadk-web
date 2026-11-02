import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'agui-text-snapshot.spec.ts', workers: 1, timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:4197', screenshot: 'only-on-failure' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 4197 --strictPort', url: 'http://127.0.0.1:4197', reuseExistingServer: false },
});
