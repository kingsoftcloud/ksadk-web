import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../../components/chat/types.js';
import { scanConversationHistory, searchConversationMessages, type HistorySearchSnapshot } from './history-search.js';

const message = (id: string, content: string): Message => ({ id, content, role: 'model', timestamp: 0 });
const initial = (): HistorySearchSnapshot => ({ owner: 'agent-a/session-a', messages: [message('latest', '最近')],
  hasMore: true, loading: false, checkpoint: '2000' });

describe('current conversation history search', () => {
  it('finds Chinese text outside the displayed 50-row tail of a 2,000-message history', async () => {
    const history = Array.from({ length: 2000 }, (_, index) => message(`m-${index}`, index === 17 ? '旧消息：验收目标' : `历史 ${index}`));
    const state = initial();
    state.messages = history.slice(-50);
    let offset = 1950;
    const readOlder = vi.fn(async () => {
      offset = Math.max(0, offset - 200);
      state.messages = history.slice(offset);
      state.hasMore = offset > 0;
      state.checkpoint = String(offset);
    });
    const result = await scanConversationHistory({ query: '验收目标', snapshot: () => state,
      readOlder, signal: new AbortController().signal });
    expect(result.complete).toBe(true);
    expect(result.searchedMessages).toBe(2000);
    expect(result.matches.map(item => item.messageId)).toEqual(['m-17']);
    expect(readOlder).toHaveBeenCalledTimes(10);
  });

  it('searches public blocks and file names but not hidden reasoning', () => {
    const result = searchConversationMessages([
      { ...message('secret', ''), reasoning: 'match hidden reasoning',
        blocks: [{ id: 'thought', type: 'thinking', content: 'match', status: 'done' }] },
      { ...message('text', ''), blocks: [{ id: 'text', type: 'text', content: 'MATCH public', status: 'done' }] },
      { ...message('file', ''), attachments: [{ name: 'match.csv', url: '/file', type: 'text/csv' }] },
      { ...message('legacy-tool', ''), tools: { lookup: { name: 'lookup', args: '{}', output: 'MATCH result', status: 'completed' } } },
      message('duplicate-text', 'MATCH public'),
    ], 'match');
    expect(result.matches.map(item => item.messageId)).toEqual(['text', 'file', 'legacy-tool', 'duplicate-text']);
  });

  it('counts all matching messages while bounding result previews', () => {
    const result = searchConversationMessages(Array.from({ length: 1000 }, (_, i) => message(String(i), 'same')), 'same');
    expect(result.matchedMessages).toBe(1000);
    expect(result.matches).toHaveLength(200);
  });

  it('waits for canonical history identities instead of returning readable fallback matches', async () => {
    const state = { ...initial(), messages: [message('fallback', '验收')], loading: true, hasMore: false };
    const progress = vi.fn();
    const ready = setTimeout(() => {
      state.messages = [message('ready', '验收')];
      state.loading = false;
    }, 20);
    try {
      const result = await scanConversationHistory({ query: '验收', snapshot: () => state,
        signal: new AbortController().signal, readOlder: async () => {}, onProgress: progress });
      expect(result.complete).toBe(true);
      expect(result.matchedMessages).toBe(1);
      expect(result.matches.map(match => match.messageId)).toEqual(['ready']);
      expect(progress).toHaveBeenCalledTimes(1);
    } finally { clearTimeout(ready); }
  });

  it('does not publish a late page after navigation', async () => {
    const state = initial();
    const progress = vi.fn();
    await expect(scanConversationHistory({ query: '旧', snapshot: () => state,
      signal: new AbortController().signal, onProgress: progress,
      readOlder: async () => { state.owner = 'agent-b/session-b'; state.messages = [message('other', '旧')]; },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress.mock.calls[0][0].matches).toEqual([]);
  });

  it('keeps fallback matches partial when canonical history could not be read', async () => {
    const state = { ...initial(), hasMore: false, error: '历史读取失败', messages: [message('fallback', '验收')] };
    const progress = vi.fn();
    await expect(scanConversationHistory({ query: '验收', snapshot: () => state,
      signal: new AbortController().signal, readOlder: async () => {}, onProgress: progress,
    })).rejects.toThrow('历史读取失败');
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ complete: false, matchedMessages: 1 }));
  });

  it('stops on a cursor that fails to advance instead of claiming complete or looping', async () => {
    const state = initial();
    await expect(scanConversationHistory({ query: 'missing', snapshot: () => state,
      signal: new AbortController().signal, readOlder: async () => {},
    })).rejects.toThrow('更早历史未返回新内容');
  });

  it('ignores reads completing after cancellation without cancelling execution', async () => {
    const state = initial();
    const abort = new AbortController();
    const progress = vi.fn();
    await expect(scanConversationHistory({ query: '旧', snapshot: () => state,
      signal: abort.signal, onProgress: progress,
      readOlder: async () => { abort.abort(); state.hasMore = false; state.messages = [message('late', '旧')]; },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress).toHaveBeenCalledTimes(1);
  });
});
