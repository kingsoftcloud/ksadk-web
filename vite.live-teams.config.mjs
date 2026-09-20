import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const port = Number(process.env.TEAMS_LIVE_WEB_PORT || 4189);
const serverPort = Number(process.env.TEAMS_LIVE_SERVER_PORT || 52400);
if (![port, serverPort].every(value => Number.isInteger(value) && value > 1024 && value < 65536)) throw new Error('Invalid local fixture port');
export default defineConfig({ plugins: [react()], resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } }, server: { host: '127.0.0.1', port, strictPort: true, proxy: {
  '/api/v1': { target: `http://127.0.0.1:${serverPort}`, changeOrigin: true },
  '/__fixture__': { target: `http://127.0.0.1:${serverPort}`, changeOrigin: true },
} } });
