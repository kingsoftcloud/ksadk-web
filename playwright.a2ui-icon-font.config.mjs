import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: 'a2ui-icon-font.spec.ts', workers: 1, timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:4196', screenshot: 'only-on-failure' },
  webServer: {
    command: 'npm run build:lib && npm run dev -- --host 127.0.0.1 --port 4196 --strictPort',
    url: 'http://127.0.0.1:4196', reuseExistingServer: false,
  },
});
