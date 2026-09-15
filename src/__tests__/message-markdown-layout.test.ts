import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

describe('message markdown layout', () => {
  for (const sourcePath of [
    'src/components/MessageMarkdown.tsx',
    'src/components/markdown/MathMessageMarkdown.tsx',
  ]) {
    it(`${sourcePath} keeps inline tool names lightweight and wrappable`, () => {
      const source = readFileSync(resolve(repoRoot, sourcePath), 'utf8');

      expect(source).toContain('break-all font-mono text-[0.92em]');
      expect(source).not.toMatch(/<code className="[^"]*\bborder\b/);
      expect(source).not.toMatch(/<code className="[^"]*\bbg-/);
    });

    it(`${sourcePath} gives tables readable cells with bounded overflow`, () => {
      const source = readFileSync(resolve(repoRoot, sourcePath), 'utf8');

      expect(source).toContain('overflow-x-auto');
      expect(source).toContain('min-w-[36rem]');
      expect(source).toContain('break-words');
      expect(source).toContain('align-top');
    });
  }

  it('keeps long code and diff blocks inspectable with line numbers, folding, and a hard cap', () => {
    const source = readFileSync(resolve(repoRoot, 'src/components/markdown/CodeBlock.tsx'), 'utf8');

    expect(source).toContain('showLineNumbers');
    expect(source).toContain('FOLD_THRESHOLD_LINES = 80');
    expect(source).toContain('MAX_VISIBLE_LINES = 500');
    expect(source).toContain('aria-expanded={expanded}');
    expect(source).toContain('超过单块');
  });

  it('keeps sandbox preview source and download affordances for html/svg blocks', () => {
    const source = readFileSync(resolve(repoRoot, 'src/components/markdown/CodeBlock.tsx'), 'utf8');

    expect(source).toContain('handleDownload');
    expect(source).toContain('anchor.download = `code-block.${extension}`');
    expect(source).toContain("useState<'preview' | 'source'>('preview')");
    expect(source).toContain("setPreviewMode('source')");
    expect(source).toContain('sandbox="allow-scripts allow-downloads"');
  });

  it('filters executable protocols from untrusted markdown links', () => {
    const source = readFileSync(resolve(repoRoot, 'src/components/MessageMarkdown.tsx'), 'utf8');

    expect(source).toContain('safeMarkdownHref');
    expect(source).toContain("['http:', 'https:', 'mailto:']");
    expect(source).toContain('if (!safeHref) return <span');
  });

  it('renders markdown images as safe lazy thumbnails with an original-image fallback', () => {
    const source = readFileSync(resolve(repoRoot, 'src/components/MessageMarkdown.tsx'), 'utf8');

    expect(source).toContain('safeMarkdownImageSrc');
    expect(source).toContain("loading=\"lazy\"");
    expect(source).toContain('查看原图');
    expect(source).toContain('图片无法加载');
    expect(source).toContain("['http:', 'https:']");
  });
});
