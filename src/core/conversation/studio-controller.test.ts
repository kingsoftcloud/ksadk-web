import { describe, expect, it } from 'vitest';
import { ConversationController, DraftStore, createConversationId, createNavigationEpoch, isCurrentNavigation } from './studio-controller.js';

describe('Studio conversation primitives', () => {
  it('creates client-owned ids and isolated drafts', () => {
    const a = createConversationId(() => 0.1);
    const b = createConversationId(() => 0.2);
    expect(a).toMatch(/^conversation_[a-z0-9]+_[a-z0-9]+_[a-z0-9]+$/);
    const store = new DraftStore();
    expect(store.set(a, '中文草稿').revision).toBe(1);
    expect(store.set(a, 'updated').revision).toBe(2);
    expect(store.set(b, 'other').text).toBe('other');
    expect(store.get(a).text).toBe('updated');
    expect(store.size()).toBe(2);
  });

  it('invalidates stale navigation work', () => {
    const epoch = createNavigationEpoch();
    const first = epoch.next();
    const second = epoch.next();
    expect(isCurrentNavigation(epoch.current, first)).toBe(false);
    expect(isCurrentNavigation(epoch.current, second)).toBe(true);
  });

  it('restores text drafts without serializing attachments', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
    } as unknown as Storage;
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
    const id = createConversationId(() => 0.3);
    const first = new DraftStore('test-drafts');
    first.set(id, 'recover me', [new File(['x'], 'secret.txt')]);
    const second = new DraftStore('test-drafts');
    expect(second.get(id).text).toBe('recover me');
    expect(second.get(id).attachments).toEqual([]);
    expect(values.get('test-drafts')).not.toContain('secret.txt');
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('bounds persisted drafts to the most recently edited entries', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); } } as Storage;
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
    const store = new DraftStore('bounded-drafts', 2);
    const first = createConversationId(() => 0.1);
    const second = createConversationId(() => 0.2);
    const third = createConversationId(() => 0.3);
    store.set(first, 'first');
    store.set(second, 'second');
    store.set(third, 'third');
    expect(store.size()).toBe(2);
    expect(store.get(first).text).toBe('');
    expect(store.get(second).text).toBe('second');
    expect(store.get(third).text).toBe('third');
    expect(JSON.parse(values.get('bounded-drafts') || '{}')).toEqual(expect.objectContaining({
      [second]: expect.anything(), [third]: expect.anything(),
    }));
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('restores the stable identity that owns a draft after reload', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); } } as Storage;
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
    const first = new ConversationController('test-bindings');
    const id = first.getOrCreate('agent-a', 'session-a');
    first.drafts.set(id, 'draft survives reload');
    const second = new ConversationController('test-bindings');
    expect(second.getOrCreate('agent-a', 'session-a')).toBe(id);
    expect(second.drafts.get(id).text).toBe('draft survives reload');
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('keeps local and cloud execution targets in separate conversations', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); } } as Storage;
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
    const first = new ConversationController('target-bindings');
    const local = first.getOrCreate('agent-a', null, 'local:agent-a');
    const cloud = first.getOrCreate('agent-a', null, 'cloud:deployment-1:version-2');
    expect(cloud).not.toBe(local);
    expect(first.binding(cloud)).toMatchObject({ agentId: 'agent-a', targetId: 'cloud:deployment-1:version-2' });
    const second = new ConversationController('target-bindings');
    expect(second.getOrCreate('agent-a', null, 'local:agent-a')).toBe(local);
    expect(second.getOrCreate('agent-a', null, 'cloud:deployment-1:version-2')).toBe(cloud);
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('maps a local conversation to a native session without changing its id', () => {
    const controller = new ConversationController();
    const conversation = controller.getOrCreate('agent-a', null);
    const rebound = controller.bindNative(conversation, 'ses_native');
    expect(rebound.conversationId).toBe(conversation);
    expect(controller.binding(conversation)?.nativeSessionId).toBe('ses_native');
    expect(controller.getOrCreate('agent-a', 'ses_native')).toBe(conversation);
  });
});
