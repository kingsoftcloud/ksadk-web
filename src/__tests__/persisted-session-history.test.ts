import { describe, expect, it } from 'vitest';
import { rebuildPersistedSessionHistory } from '../utils/persisted-session-history.js';
import type { Message } from '../components/chat/types.js';
import type { PersistedSessionEventRecord } from '../utils/persisted-session-history.js';

describe('rebuildPersistedSessionHistory', () => {
  it('normalises RuntimeEvent Unix seconds before ordering with millisecond message rows', () => {
    const fallback: Message[] = [{
      id: 'user-1',
      role: 'user',
      content: '先提问',
      timestamp: 1_700_000_000_000,
    }];
    const events: PersistedSessionEventRecord[] = [{
      SeqId: 1,
      EventId: 'event-1',
      EventType: 'runtime.item.completed',
      InvocationId: 'run-1',
      // Production RuntimeEvent/v2 persists this value in Unix seconds.
      Timestamp: 1_700_000_001 as unknown as string,
      Content: {
        runtime_event: {
          family: 'runtime',
          event_type: 'item.completed',
          event_id: 'event-1',
          run_id: 'run-1',
          scope_id: 'run-1',
          item_id: 'assistant-1',
          item_kind: 'message',
          snapshot: { parts: [{ part_id: 'text-1', text: '再回答' }] },
          source: { metadata: { native_item_kind: 'agentMessage' } },
        },
      },
    }];

    const rebuilt = rebuildPersistedSessionHistory(fallback, events, 'session-1');

    expect(rebuilt.messages.map((message) => message.content)).toEqual(['先提问', '再回答']);
    expect(rebuilt.messages[1]?.timestamp).toBe(1_700_000_001_000);
  });

  it('keeps the compatibility projection when canonical history contains only a user item', () => {
    const fallback: Message[] = [
      {
        id: 'user-fallback',
        role: 'user',
        content: '继续上文',
        timestamp: 1_700_000_000_000,
        invocationId: 'run-incomplete',
      },
      {
        id: 'assistant-fallback',
        role: 'model',
        content: '这是仍可从兼容投影读取的回复。',
        timestamp: 1_700_000_001_000,
        invocationId: 'run-incomplete',
      },
    ];
    const events: PersistedSessionEventRecord[] = [{
      SeqId: 1,
      EventId: 'event-user-only',
      EventType: 'runtime.item.completed',
      InvocationId: 'run-incomplete',
      Timestamp: 1_700_000_000 as unknown as string,
      Content: {
        runtime_event: {
          family: 'runtime',
          event_type: 'item.completed',
          event_id: 'event-user-only',
          run_id: 'run-incomplete',
          scope_id: 'run-incomplete',
          item_id: 'user-item',
          item_kind: 'message',
          snapshot: {
            parts: [{
              part_id: 'user-part',
              content_type: 'data',
              data: {
                type: 'userMessage',
                content: [{ type: 'text', text: '继续上文' }],
              },
            }],
          },
          source: { metadata: { native_item_kind: 'userMessage' } },
        },
      },
    }];

    const rebuilt = rebuildPersistedSessionHistory(fallback, events, 'session-1');

    expect(rebuilt.messages.map((message) => message.content)).toEqual([
      '继续上文',
      '这是仍可从兼容投影读取的回复。',
    ]);
    expect(rebuilt.canonicalRunIds).toEqual([]);
  });
});
