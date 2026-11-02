import { defineConfig, mergeConfig } from 'vite';
import base from '../vite.config.js';

// Test-only consumer of the normal build; never changes a published entrypoint.
export default mergeConfig(base, defineConfig({
  build: { rollupOptions: { input: { app: 'index.html', custom: 'e2e/fixtures/custom-catalog.html' } } },
}));
