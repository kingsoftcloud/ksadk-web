import { mergeConfig } from 'vite';
import { fileURLToPath } from 'node:url';

import baseConfig from './vite.config.ts';

const fixtureTarget = 'http://127.0.0.1:4182';

export default mergeConfig(baseConfig, {
  resolve: {
    // The independent browser fixture deliberately imports the documented
    // package subpath instead of reaching into Hosted UI implementation code.
    alias: {
      '@kingsoftcloud/ksadk-web/conversation': fileURLToPath(
        new URL('./src/public/conversation.ts', import.meta.url),
      ),
    },
  },
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
