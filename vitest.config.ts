import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(viteConfig, defineConfig({
  test: {
    // Independent Git checkouts have their own dependencies and test baselines.
    exclude: [...configDefaults.exclude, '**/.worktrees/**'],
  },
}));
