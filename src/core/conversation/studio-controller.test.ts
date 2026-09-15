import { describe, expect, it } from 'vitest';
import { DraftStore, createConversationId, createNavigationEpoch, isCurrentNavigation } from './studio-controller.js';

describe('Studio conversation primitives', () => {
  it('creates client-owned ids and isolated drafts', () => {
    const a = createConversationId(() => 0.1);
    const b = createConversationId(() => 0.2);
    expect(a).toMatch(/^conversation_[a-z0-9]+_[a-z0-9]+$/);
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
});
