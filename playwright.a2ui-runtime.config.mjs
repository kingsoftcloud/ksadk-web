import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const output = process.env.KSADK_TEST_OUTPUT_DIR || 'output/playwright/a2ui-runtime';
export default defineConfig({
  testDir: './e2e', testMatch: 'a2ui-runtime.spec.mjs', workers: 1, timeout: 60_000,
  outputDir: `${output}/results`,
  reporter: [['list'], ['json', { outputFile: `${output}/report.json` }]],
  metadata: { scope: 'Real FastAPI, LangGraph, SQLite, production Web build and Chromium; no API/SSE interception' },
  use: {
    launchOptions: existsSync(chrome) ? { executablePath: chrome } : {},
    viewport: { width: 1440, height: 1100 }, trace: 'retain-on-failure',
  },
});
