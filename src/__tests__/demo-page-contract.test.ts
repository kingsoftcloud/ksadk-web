import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('public demo page contract', () => {
  it('builds a dedicated interactive demo instead of bootstrapping a missing Agent', () => {
    const main = readFileSync(resolve(repoRoot, 'src/main.tsx'), 'utf8');
    const demo = readFileSync(resolve(repoRoot, 'src/demo/DemoWorkbench.tsx'), 'utf8');
    const pages = readFileSync(resolve(repoRoot, '.github/workflows/pages.yml'), 'utf8');

    expect(main).toContain("import.meta.env.VITE_DEMO_MODE === '1'");
    expect(demo).toContain('本地交互演示');
    expect(demo).toContain('不会连接或冒充真实 Agent');
    expect(demo).toContain('setMessages');
    expect(demo).toContain('status: \'streaming\'');
    expect(pages).toContain('npm run build:demo');
    expect(pages).toContain('path: dist-demo');
  });

  it('uses the WeWork-style text shimmer while reasoning is streaming', () => {
    const source = readFileSync(
      resolve(repoRoot, 'src/components/chat/ProcessingBlocksView.tsx'),
      'utf8',
    );

    const styles = readFileSync(resolve(repoRoot, 'src/index.css'), 'utf8');
    expect(source).toContain("generating && 'waiting-thinking-text'");
    expect(source).toContain("data-testid={generating ? 'thinking-indicator'");
    expect(source).toContain("generating ? '正在思考' : '已思考'");
    expect(styles).toContain('@keyframes waiting-thinking-text');
    expect(styles).toContain('animation: waiting-thinking-text 1.6s linear infinite');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
