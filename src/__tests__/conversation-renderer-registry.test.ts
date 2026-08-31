import { describe, expect, it } from 'vitest';

import {
  createTrustedRendererCatalog,
  type ConversationItem,
} from '../core/conversation/index.js';

const item: ConversationItem = {
  apiVersion: 'conversation.ksadk.io/v1',
  kindVersion: 1,
  itemId: 'tool-1',
  sourceEventIds: ['event-1'],
  sessionId: 'session-1',
  runId: 'run-1',
  kind: 'tool_call',
  operation: 'append',
  lifecycle: 'streaming',
  visibility: 'public',
  payloadSchemaRef: 'conversation.item.tool-call/v1',
  payload: {},
  nativeRef: {},
};

describe('trusted conversation renderer catalog', () => {
  it('matches an exact schema and kind, never a future version', () => {
    const catalog = createTrustedRendererCatalog([{
      id: 'core.tool-call',
      schemaRef: 'conversation.item.tool-call/v1',
      kinds: ['tool_call'],
    }]);

    expect(catalog.resolve(item)?.id).toBe('core.tool-call');
    expect(catalog.resolve({ ...item, payloadSchemaRef: 'conversation.item.tool-call/v99' }))
      .toBeUndefined();
    expect(catalog.resolve({ ...item, kind: 'assistant_text' }))
      .toBeUndefined();
  });

  it('rejects duplicate schema ownership at host construction', () => {
    expect(() => createTrustedRendererCatalog([
      { id: 'one', schemaRef: 'vendor.card/v1', kinds: ['unknown'] },
      { id: 'two', schemaRef: 'vendor.card/v1', kinds: ['unknown'] },
    ])).toThrow('duplicate trusted conversation renderer schemaRef');
  });
});
