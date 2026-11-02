import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProcessingBlocksView } from '../components/chat/ProcessingBlocksView';
import type { Message } from '../components/chat/types';

describe('host processing presentation compatibility', () => {
  it('keeps canonical ordering, explicit suppression and shared fallback', () => {
    const message: Message = { id: 'message', role: 'model', content: '', timestamp: 1, blocks: [
      { id: 'thought', type: 'thinking', source: 'provider_reasoning', content: 'public reasoning', status: 'done' },
      { id: 'tool', type: 'tool', toolName: 'read_file', args: '', output: 'raw result', status: 'completed' },
      { id: 'text', type: 'text', content: 'Final answer', status: 'done' },
    ] };
    const html = renderToStaticMarkup(createElement(ProcessingBlocksView, {
      message, isStreaming: false,
      renderProcessingBlock: (block, owner) => {
        expect(owner).toBe(message);
        if (block.type === 'thinking') return null;
        if (block.type === 'tool') return createElement('span', {}, 'Host tool card');
        return undefined;
      },
    }));
    expect(html).toContain('Host tool card');
    expect(html).toContain('Final answer');
    expect(html.indexOf('Host tool card')).toBeLessThan(html.indexOf('Final answer'));
    expect(html).not.toContain('public reasoning');
    expect(html).not.toContain('raw result');
  });
});
