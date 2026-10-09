import { rebuildPersistedSessionHistory } from '../utils/persisted-session-history.js';
import { describe, expect, it } from 'vitest';
import { KernelRunEventTranslator } from '../core/stream/kernel-events.js';
import { RuntimeItemReducer, sessionEventToItemOperation } from '../core/stream/runtime-items.js';

// Shape observed in the R87 preproduction log: three append deltas followed
// by a complete snapshot of the same named part. No deployment identifiers.
describe('Codex durable history replay', () => {
  it('keeps the final snapshot once after translating the complete event sequence', () => {
    const translator = new KernelRunEventTranslator('session-test');
    const reducer = new RuntimeItemReducer();
    const base = { schema_version: 2, scope_id: 'scope-test', family: 'runtime', family_version: 2, run_id: 'run-test',
      item_id: 'item-test', item_kind: 'message',
      source: { metadata: { native_item_kind: 'agentMessage' } } };
    const frames = [
      { event_type: 'item.started', phase: 'final_answer' },
      ...['R', '87-HANDOFF-5', 'ae1549413'].map(text => ({
        event_type: 'item.updated', op: 'append',
        update: { part_id: 'part-test', content_type: 'text', text },
      })),
      { event_type: 'item.completed', snapshot: { parts: [{
        part_id: 'part-test', content_type: 'text', text: 'R87-HANDOFF-5ae1549413',
      }] } },
    ];
    frames.forEach((frame, index) => {
      const record = translator.translate({ ...base, ...frame, seq: index + 1, event_id: `event-${index}` });
      if (!record) return;
      const operation = sessionEventToItemOperation(record);
      if (operation) reducer.apply(operation);
    });
    const history = rebuildPersistedSessionHistory([], frames.map((frame, index) => ({
      SeqId: index + 1, EventId: `event-${index}`, EventType: frame.event_type,
      InvocationId: 'run-test', Timestamp: 1700000000000 + index,
      Content: { runtime_event: { ...base, ...frame, seq: index + 1, event_id: `event-${index}` } },
    })), 'session-test');
    expect(history.messages.filter(message => message.role === 'model').map(message => message.content))
      .toEqual(['R87-HANDOFF-5ae1549413']);
    const items = reducer.snapshot().items;
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('completed');
    expect(items[0].parts.map(part => part.text || '').join('')).toBe('R87-HANDOFF-5ae1549413');
  });
});
