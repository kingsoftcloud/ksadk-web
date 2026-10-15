import { mergeConfig } from 'vite';
import base from './vite.config';

export default mergeConfig(base, {
  server: { proxy: { '/agentengine': {
    target: process.env.MIXED_HISTORY_SERVER_URL, changeOrigin: true,
    headers: { 'X-Ksc-Account-Id': 'acceptance' },
  } } },
});
