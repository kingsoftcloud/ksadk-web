import { describe, expect, it } from 'vitest';
import type { Message } from '../components/chat/types.js';
import { mergeRecoveredRunMessages } from '../utils/recovered-run.js';

describe('mergeRecoveredRunMessages', () => {
  it('replaces a partial history row using the stable invocation id', () => {
    const history: Message[] = [{
      id: 'snapshot-1',
      role: 'model',
      content: '这是一段已经',
      timestamp: 1,
      invocationId: 'inv-1',
    }];

    const merged = mergeRecoveredRunMessages(history, [{
      EventId: 'snapshot-2',
      EventType: 'assistant_stream_snapshot',
      InvocationId: 'inv-1',
      SeqId: 2,
      Content: { role: 'assistant', parts: [{ text: '这是一段已经恢复的完整回复。' }] },
      Timestamp: 2,
    }], 'inv-1');

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: 'snapshot-1',
      invocationId: 'inv-1',
      content: '这是一段已经恢复的完整回复。',
    });
  });
});
