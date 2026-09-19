import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionLifecycle } from '../hooks/useSessionLifecycle.js';
import { useSessionStore } from '../stores/session.js';
import { useMessageStore } from '../stores/message.js';
import { useBootstrapStore } from '../stores/bootstrap.js';
import type { ApiFacade } from '../core/api/types.js';
import type { UiCapabilities } from '../types/capabilities.js';

function lifecycle(api: Partial<ApiFacade>, restoreSession = false) {
  let actions!: ReturnType<typeof useSessionLifecycle>;
  function Probe() {
    actions = useSessionLifecycle({ agentId: 'agent-a', currentSessionId: 'current',
      isMobile: false, uiCapabilities: { RunLifecycle: { Enabled: false } } as UiCapabilities, api: api as ApiFacade,
      resetCompaction: () => {}, restoreSession });
    return null;
  }
  renderToString(createElement(Probe));
  return actions;
}

describe('shared session lifecycle actions', () => {
  beforeEach(() => {
    useBootstrapStore.getState().setAgentId('agent-a');
    useSessionStore.getState().resetSessionPagination('agent-a');
    useSessionStore.getState().setCurrentSessionId('current');
    useMessageStore.getState().setMessages([{ id: 'old-message', role: 'user', content: '旧消息', timestamp: 1 }]);
  });

  it('ignores a late session list from an Agent that has already been switched away from', async () => {
    let finish!: (value: unknown) => void;
    const actions = lifecycle({ listSessions: vi.fn(() => new Promise(resolve => { finish = resolve; })) });
    const pending = actions.fetchSessions('agent-a');
    useBootstrapStore.getState().setAgentId('agent-b');
    useSessionStore.getState().resetSessionPagination('agent-b');
    useSessionStore.getState().setCurrentSessionId(null);
    finish({ Sessions: [{ SessionId: 'old-agent-session' }], Total: 1 });
    await pending;
    expect(useSessionStore.getState().sessions).toEqual([]);
    expect(useSessionStore.getState().currentSessionId).toBeNull();
  });

  it('coalesces repeated explicit session creation while the request is in flight', async () => {
    let finish!: (value: { SessionId: string }) => void;
    const createSession = vi.fn(() => new Promise<{ SessionId: string }>(resolve => { finish = resolve; }));
    const actions = lifecycle({ createSession });
    const first = actions.createNewSession();
    const second = actions.createNewSession();
    expect(createSession).toHaveBeenCalledTimes(1);
    finish({ SessionId: 'new-session' });
    await Promise.all([first, second]);
    expect(useSessionStore.getState().currentSessionId).toBe('new-session');
  });

  it('opens a blank draft without creating sessions, including repeated clicks and list refresh', async () => {
    const createSession = vi.fn();
    const listSessionMessages = vi.fn();
    const actions = lifecycle({ createSession, listSessionMessages,
      listSessions: vi.fn().mockResolvedValue({ Sessions: [{ SessionId: 'old' }], Total: 1 }) });
    actions.startNewConversation();
    actions.startNewConversation();
    await actions.fetchSessions('agent-a', 'old');
    expect(createSession).not.toHaveBeenCalled();
    expect(listSessionMessages).not.toHaveBeenCalled();
    expect(useSessionStore.getState().currentSessionId).toBeNull();
    expect(useMessageStore.getState().messages).toEqual([]);
  });

  it('does not evict selected history that is absent from the refreshed first page', async () => {
    const actions = lifecycle({ listSessions: vi.fn().mockResolvedValue({ Sessions: [{ SessionId: 'recent' }], Total: 500 }) });
    await actions.fetchSessions('agent-a', 'recent');
    expect(useSessionStore.getState().currentSessionId).toBe('current');
    expect(useMessageStore.getState().messages.map(item => item.id)).toEqual(['old-message']);
  });

  it('keeps a deleted selected session on the blank draft instead of entering another history', async () => {
    const listSessionMessages = vi.fn();
    const actions = lifecycle({ deleteSession: vi.fn().mockResolvedValue({}), listSessionMessages,
      listSessions: vi.fn().mockResolvedValue({ Sessions: [{ SessionId: 'old' }], Total: 1 }) });
    await actions.deleteSession('current');
    await Promise.resolve();
    expect(useSessionStore.getState().currentSessionId).toBeNull();
    expect(useMessageStore.getState().messages).toEqual([]);
    expect(listSessionMessages).not.toHaveBeenCalled();
  });
});
