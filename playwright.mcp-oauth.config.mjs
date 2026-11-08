import { defineConfig } from '@playwright/test';
const staticRoot = process.env.MCP_LAB_STATIC_ROOT;
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export default defineConfig({
  testDir: './e2e', testMatch: 'mcp-oauth.spec.ts', timeout: 90_000,
  use: { baseURL: 'http://127.0.0.1:4178', viewport: { width: 1280, height: 900 }, screenshot: 'only-on-failure' },
  webServer: { command: staticRoot ? `python3 -m http.server 4178 --bind 127.0.0.1 --directory ${shellQuote(staticRoot)}` : 'npm run dev -- --host 127.0.0.1 --port 4178 --strictPort', url: 'http://127.0.0.1:4178', reuseExistingServer: false },
});
