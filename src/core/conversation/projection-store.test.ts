import { describe, expect, it } from 'vitest';
import { ConversationProjectionStore } from './projection-store.js';
import { createConversationId } from './studio-controller.js';
import type { ConversationItem } from './types.js';

function item(id: string, source: string, text: string, lifecycle: ConversationItem['lifecycle'] = 'streaming'): ConversationItem {
  return { apiVersion: 'conversation.ksadk.io/v1', kindVersion: 1, itemId: id, kind: 'assistant_text', operation: 'replace', lifecycle, visibility: 'public', payloadSchemaRef: 'conversation.item.text/v1', payload: { text }, sourceEventIds: [source], nativeRef: {} };
}

describe('ConversationProjectionStore', () => {
  it('deduplicates live replay and persists a source checkpoint', () => {
    const store = new ConversationProjectionStore();
    const id = createConversationId(() => 0.3);
    expect(store.apply(id, item('i1', 'e1', 'hello'), 'rev-a', 1)).toBe(true);
    expect(store.apply(id, item('i1', 'e1', 'hello'), 'rev-a', 1)).toBe(false);
    expect(store.snapshot(id)?.items).toHaveLength(1);
    expect(store.checkpointFor(id)).toMatchObject({ sourceRevision: 'rev-a', cursor: 1, projectionSchemaVersion: 1 });
  });

  it('replaces a projection when the source revision changes', () => {
    const store = new ConversationProjectionStore();
    const id = createConversationId(() => 0.4);
    store.apply(id, item('old', 'e1', 'old'), 'rev-a');
    store.replace(id, [item('new', 'e2', 'new', 'completed')], 'rev-b', 8);
    expect(store.snapshot(id)?.items.map((value) => value.itemId)).toEqual(['new']);
    expect(store.checkpointFor(id)?.sourceRevision).toBe('rev-b');
  });
});
