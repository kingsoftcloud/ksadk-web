import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: 'mixed-history.spec.ts', workers: 1,
  timeout: 90_000, expect: { timeout: 20_000 },
  use: { baseURL: 'http://127.0.0.1:4189', viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: {
    command: 'npx vite --config vite.mixed-history.config.ts --host 127.0.0.1 --port 4189 --strictPort',
    url: 'http://127.0.0.1:4189/e2e/fixtures/mixed-history.html', reuseExistingServer: false,
  },
});
