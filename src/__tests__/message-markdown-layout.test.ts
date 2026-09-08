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
});
