import { mergeConfig } from 'vite';
import base from './vite.config';

export default mergeConfig(base, {
  server: { proxy: { '/agentengine': { target: 'http://127.0.0.1:18087', changeOrigin: true } } },
});
