import { mergeConfig } from 'vite';

import baseConfig from './vite.config.ts';

const fixtureTarget = 'http://127.0.0.1:4182';

export default mergeConfig(baseConfig, {
  server: {
    proxy: {
      '/agentengine': {
        target: fixtureTarget,
        changeOrigin: true,
      },
      '/api': {
        target: fixtureTarget,
        changeOrigin: true,
      },
    },
  },
});
