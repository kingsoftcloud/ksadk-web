import { defineConfig } from '@playwright/test';
import local from './playwright.local-heavy-history.config.mjs';

if (!process.env.KSADK_TEST_POSTGRES_DSN || !process.env.KSADK_RUNTIME_PROJECT) {
  throw new Error('Set KSADK_TEST_POSTGRES_DSN and KSADK_RUNTIME_PROJECT to a test database and the Python checkout.');
}

export default defineConfig({
  ...local,
  testMatch: 'large-invocation.spec.ts',
  webServer: [
    { command: 'uv run --no-sync --project "$KSADK_RUNTIME_PROJECT" python e2e/fixtures/large-invocation-runtime.py',
      port: 18087, gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } },
    local.webServer,
  ],
});
