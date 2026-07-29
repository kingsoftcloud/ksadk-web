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
      'session-a': { nextCursor: 8, hasMore: true, isLoadingInitial: false, isLoadingOlder: true },
      'session-b': { nextCursor: null, hasMore: false, isLoadingInitial: false, isLoadingOlder: false },
    });

    store.clearSessionMessageHistory('session-a');

    expect(useSessionStore.getState().messageHistory).toEqual({
      'session-b': { nextCursor: null, hasMore: false, isLoadingInitial: false, isLoadingOlder: false },
    });
  });

  it('starts in restoring mode so the first paint cannot claim an empty session', () => {
    expect(useSessionStore.getState().isLoadingSessions).toBe(true);
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

  it('tracks initial history loading independently from loading older pages', () => {
    const store = useSessionStore.getState();

    store.setSessionInitialMessageHistoryLoading('session-a', true);

    expect(useSessionStore.getState().messageHistory['session-a']).toEqual({
      nextCursor: null,
      hasMore: false,
      isLoadingOlder: false,
      isLoadingInitial: true,
    });

    store.setSessionMessageHistory('session-a', { nextCursor: null, hasMore: false });

    expect(useSessionStore.getState().messageHistory['session-a']?.isLoadingInitial).toBe(false);
  });
});
