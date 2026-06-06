import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

describe('chat message list contracts', () => {
  it('only auto-scrolls when the user is already near the bottom', () => {
    const source = readFileSync(resolve(repoRoot, 'src/components/chat/ConnectedMessageList.tsx'), 'utf8');

    expect(source).toContain('stickToBottomRef');
    expect(source).toContain('distanceFromBottom < 96');
    expect(source).not.toMatch(/scrollRef\.current\.scrollTop\s*=\s*scrollRef\.current\.scrollHeight/);
  });

  it('keeps reasoning panels scrollable and lightweight', () => {
    const source = readFileSync(resolve(repoRoot, 'src/components/chat/ChatMessageList.tsx'), 'utf8');

    expect(source).toContain('group-open/details:rotate-180');
    expect(source).toContain('max-h-[min(46vh,28rem)]');
    expect(source).toContain('custom-scrollbar');
  });
});
