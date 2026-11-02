import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export default defineConfig({
  testDir: './e2e', testMatch: 'custom-catalog-runtime.spec.mjs',
  timeout: 90000, workers: 1, fullyParallel: false,
  outputDir: process.env.KSADK_TEST_CUSTOM_OUTPUT || 'test-results/custom-catalog',
  reporter: [['list'], ['json', { outputFile: `${process.env.KSADK_TEST_CUSTOM_OUTPUT || 'test-results/custom-catalog'}/report.json` }]],
  use: { headless: true, browserName: 'chromium', trace: 'retain-on-failure', viewport: { width: 1280, height: 1000 },
    launchOptions: existsSync(chrome) ? { executablePath: chrome } : {} },
});
