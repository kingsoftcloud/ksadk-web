import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'output/playwright/run-owners-dist',
    rollupOptions: { input: ['run-owners', 'run-progress'].map(name => path.resolve(import.meta.dirname, `e2e/${name}.html`)) },
  },
});
