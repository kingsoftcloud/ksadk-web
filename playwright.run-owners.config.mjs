import { defineConfig } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = import.meta.dirname;
const sources = directory => readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
  const file = path.join(directory, entry.name);
  return entry.isDirectory() ? (entry.name === '__tests__' ? [] : sources(file)) : /\.(tsx?|css)$/.test(file) ? [file] : [];
});
const hash = createHash('sha256');
for (const file of [...sources('src'), 'e2e/run-owners-fixture.tsx', 'vite.run-owners.config.ts'].sort()) hash.update(file).update(readFileSync(path.join(root, file)));

export default defineConfig({
  testDir: './e2e', testMatch: 'run-owners.spec.mjs', workers: 1, timeout: 45_000,
  outputDir: 'output/playwright/run-owners-results',
  reporter: [['list'], ['json', { outputFile: 'output/playwright/run-owners-report.json' }]],
  metadata: { fixture: 'production build; real hooks/composer/timeline; synthetic transport; no runtime or cloud execution', sourceSha256: hash.digest('hex') },
  use: { baseURL: 'http://127.0.0.1:4194', viewport: { width: 1440, height: 1100 },
    channel: process.env.STUDIO_BROWSER_CHANNEL || undefined, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: {
    command: 'npx vite build --config vite.run-owners.config.ts && npx vite preview --outDir output/playwright/run-owners-dist --host 127.0.0.1 --port 4194 --strictPort',
    url: 'http://127.0.0.1:4194/e2e/run-owners.html', reuseExistingServer: false,
  },
});
