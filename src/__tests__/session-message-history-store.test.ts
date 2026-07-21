import { afterEach, describe, expect, it } from 'vitest';
import { useSessionStore } from '../stores/session.js';
import { ownsOlderMessageScrollRequest } from '../utils/session-message-history.js';

describe('session message history state', () => {
  afterEach(() => {
    useSessionStore.getState().clearSessionMessageHistory();
  });

  it('keeps independent cursors per session and clears only the requested session', () => {
    const store = useSessionStore.getState();
    store.setSessionMessageHistory('session-a', { nextCursor: 8, hasMore: true });
    store.setSessionMessageHistory('session-b', { nextCursor: null, hasMore: false });
    store.setSessionMessageHistoryLoading('session-a', true);

    expect(useSessionStore.getState().messageHistory).toEqual({
      'session-a': { nextCursor: 8, hasMore: true, isLoadingOlder: true },
      'session-b': { nextCursor: null, hasMore: false, isLoadingOlder: false },
    });

    store.clearSessionMessageHistory('session-a');

    expect(useSessionStore.getState().messageHistory).toEqual({
      'session-b': { nextCursor: null, hasMore: false, isLoadingOlder: false },
    });
  });

  it('rejects stale older-message scroll work after session or request changes', () => {
    const requestToken = Symbol('request-a');

    expect(ownsOlderMessageScrollRequest({
      requestedSessionId: 'session-a',
      activeSessionId: 'session-a',
      requestToken,
      activeRequestToken: requestToken,
    })).toBe(true);
    expect(ownsOlderMessageScrollRequest({
      requestedSessionId: 'session-a',
      activeSessionId: 'session-b',
      requestToken,
      activeRequestToken: requestToken,
    })).toBe(false);
    expect(ownsOlderMessageScrollRequest({
      requestedSessionId: 'session-a',
      activeSessionId: 'session-a',
      requestToken,
      activeRequestToken: Symbol('replacement'),
    })).toBe(false);
  });
});
