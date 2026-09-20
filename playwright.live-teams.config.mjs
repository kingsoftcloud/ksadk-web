import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const server = fileURLToPath(new URL('../agentengine-server', import.meta.url));
const port = Number(process.env.TEAMS_LIVE_WEB_PORT || 4189);
const serverPort = Number(process.env.TEAMS_LIVE_SERVER_PORT || 52400);
if (![port, serverPort].every(value => Number.isInteger(value) && value > 1024 && value < 65536)) throw new Error('Invalid local fixture port');
export default defineConfig({ testDir: './e2e', testMatch: ['live-cloud-teams.spec.ts', 'live-cloud-effects.spec.ts', 'live-cloud-materials.spec.ts', 'live-cloud-standby.spec.ts'], fullyParallel: false, workers: 1, timeout: 30_000,
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true, viewport: { width: 1440, height: 1000 } },
  webServer: [
    { command: `.venv/bin/python tests/teams/live_workspace_server.py --port ${serverPort}`, cwd: server, url: `http://127.0.0.1:${serverPort}/__fixture__/metadata`, timeout: 90_000, reuseExistingServer: !process.env.CI },
    { command: 'npx vite --config vite.live-teams.config.mjs', url: `http://127.0.0.1:${port}/e2e/fixtures/live-cloud-teams.html`, reuseExistingServer: !process.env.CI },
  ],
});
