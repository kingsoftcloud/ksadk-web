import { defineConfig } from '@playwright/test';
import local from './playwright.local-heavy-history.config.mjs';

// One Vite instance serves all browser projects. Each project points at its
// own Server + Runtime so every cursor, retry, and rendered tool is real.
const targets = process.env.KSADK_HISTORY_FACADES;
const projects = targets?.split(',').map(entry => {
  const separator = entry.indexOf('=');
  if (separator < 1) throw new Error('Expected KSADK_HISTORY_FACADES as tag=url,tag=url.');
  const name = entry.slice(0, separator);
  const facade = new URL(entry.slice(separator + 1)).href;
  return { name, metadata: { facade } };
});

export default defineConfig({
  ...local,
  testMatch: 'released-runtime-history.spec.ts',
  ...(projects ? { projects, workers: 2 } : {}),
});
