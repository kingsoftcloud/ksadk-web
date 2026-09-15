import { beforeEach, describe, expect, it } from 'vitest';
import { OutboxStore, type ConversationId } from '../core/conversation/studio-controller.js';

const conversationId = 'conversation_outbox_test' as ConversationId;

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) || null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
  });
});

describe('OutboxStore', () => {
  it('persists intent and attachment metadata, then restores it without file bytes', () => {
    const store = new OutboxStore('test-outbox');
    const entry = store.enqueue({ requestId: 'request-1', conversationId, agentId: 'agent-a', text: 'hello',
      attachments: [{ name: 'notes.txt', type: 'text/plain', size: 12 }] });
    expect(entry.status).toBe('pending');
    expect(store.markSending('request-1')?.attempt).toBe(1);
    expect(store.update('request-1', { status: 'unknown', error: 'connection lost' })).toMatchObject({ status: 'unknown', error: 'connection lost' });
    const restored = new OutboxStore('test-outbox');
    expect(restored.list(conversationId)).toEqual([expect.objectContaining({ requestId: 'request-1', status: 'unknown',
      text: 'hello', attachments: [{ name: 'notes.txt', type: 'text/plain', size: 12 }] })]);
  });

  it('deduplicates a request id and evicts terminal entries before unresolved work', () => {
    const store = new OutboxStore('bounded-outbox', 2);
    store.enqueue({ requestId: 'done', conversationId, agentId: 'agent-a', text: 'done', attachments: [] });
    store.update('done', { status: 'completed' });
    store.enqueue({ requestId: 'pending', conversationId, agentId: 'agent-a', text: 'pending', attachments: [] });
    expect(store.enqueue({ requestId: 'pending', conversationId, agentId: 'agent-a', text: 'duplicate', attachments: [] }).text).toBe('pending');
    store.enqueue({ requestId: 'new', conversationId, agentId: 'agent-a', text: 'new', attachments: [] });
    expect(store.get('done')).toBeUndefined();
    expect(store.get('pending')).toBeDefined();
    expect(store.get('new')).toBeDefined();
  });

  it('requires an explicit requeue for failed or unknown work', () => {
    const store = new OutboxStore('retry-outbox');
    store.enqueue({ requestId: 'unknown', conversationId, agentId: 'agent-a', text: 'retry me', attachments: [] });
    store.update('unknown', { status: 'unknown', error: 'connection lost' });
    expect(store.listUnresolved(conversationId).map(entry => entry.requestId)).toEqual(['unknown']);
    expect(store.requeue('unknown')).toMatchObject({ status: 'pending', error: undefined });
    expect(store.requeue('unknown')?.status).toBe('pending');
    store.update('unknown', { status: 'completed' });
    expect(store.requeue('unknown')?.status).toBe('completed');
  });

  it('keeps attachment bytes runtime-only and refuses to imply recovery after restore', () => {
    const store = new OutboxStore('attachment-outbox');
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    const entry = store.enqueue({ requestId: 'with-file', conversationId, agentId: 'agent-a', text: 'send file',
      attachments: [{ name: file.name, type: file.type, size: file.size }] });
    store.setRuntimeAttachments(entry.requestId, [file]);
    expect(store.getRuntimeAttachments(entry.requestId)).toHaveLength(1);
    const restored = new OutboxStore('attachment-outbox');
    expect(restored.getRuntimeAttachments(entry.requestId)).toHaveLength(0);
  });
});
