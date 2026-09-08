import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');

describe('embedded Tailwind scope', () => {
  it('keeps full-screen utilities below the ksadk-web scope in loading and ready states', () => {
    expect(appSource.match(/<div className="ksadk-web">/g)).toHaveLength(2);
    expect(appSource.match(/\n\s*<div className="fixed inset-0 flex/g)).toHaveLength(2);
    expect(appSource).not.toContain('className="ksadk-web fixed');
  });
});
