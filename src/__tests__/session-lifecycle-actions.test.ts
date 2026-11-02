import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionLifecycle } from '../hooks/useSessionLifecycle.js';
import { useSessionStore } from '../stores/session.js';
import { useMessageStore } from '../stores/message.js';
import { useBootstrapStore } from '../stores/bootstrap.js';
import type { ApiFacade } from '../core/api/types.js';
import type { UiCapabilities } from '../types/capabilities.js';
import type { Session } from '../components/chat/types.js';
import { CancelledError } from '../api/client.js';
import { sharedInteractionStore } from '../core/interaction/index.js';

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
    sharedInteractionStore.clearSession('history-session');
    useBootstrapStore.getState().setAgentId('agent-a');
    useSessionStore.getState().resetSessionPagination('agent-a');
    useSessionStore.getState().setCurrentSessionId('current');
    useMessageStore.getState().setMessages([{ id: 'old-message', role: 'user', content: '旧消息', timestamp: 1 }]);
  });

  it('waits for durable terminal facts before restoring a legacy pending snapshot', async () => {
    let finish!: (value: unknown) => void;
    const actions = lifecycle({
      listSessionMessages: vi.fn().mockResolvedValue({ Messages: [{ MessageId: 'approval', Role: 'assistant',
        ToolEvents: [{ Name: 'query', Status: 'paused', ApprovalRequestId: 'approval-1' }] }], HasMore: false }),
      listSessionEvents: vi.fn(() => new Promise(resolve => { finish = resolve; })) as ApiFacade['listSessionEvents'],
      getResponseFeedback: vi.fn().mockResolvedValue(null),
    });
    const loading = actions.loadSession('history-session');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(sharedInteractionStore.listPending('history-session')).toHaveLength(0);
    finish({ Events: [{ EventType: 'interaction.resolved', SessionId: 'history-session', SeqId: 2,
      Content: { interaction_id: 'approval-1', outcome: 'approved', revision: 2 } }], Total: 1 });
    await loading;
    expect(sharedInteractionStore.listPending('history-session')).toHaveLength(0);
    expect(sharedInteractionStore.get('history-session', 'approval-1')?.outcome).toBe('approved');
  });

  it('restores older legacy approvals without reviving already processed IDs', async () => {
    const actions = lifecycle({
      listSessionMessages: vi.fn()
        .mockResolvedValueOnce({ Messages: [{ MessageId: 'recent', Role: 'assistant',
          ToolEvents: [{ Name: 'query', Status: 'approved', ApprovalRequestId: 'done' }] }],
          HasMore: true, NextCursor: 10 })
        .mockResolvedValueOnce({ Messages: [{ MessageId: 'older', Role: 'assistant', ToolEvents: [
          { Name: 'query', Status: 'paused', ApprovalRequestId: 'done' },
          { Name: 'query', Status: 'paused', ApprovalRequestId: 'outstanding' },
        ] }], HasMore: false, NextCursor: null }),
      listSessionEvents: vi.fn().mockResolvedValue({ Events: [], Total: 0 }),
      getResponseFeedback: vi.fn().mockResolvedValue(null),
    });
    await actions.loadSession('history-session');
    await actions.loadOlderSessionMessages('history-session');
    expect(sharedInteractionStore.listPending('history-session').map(record => record.interactionId)).toEqual(['outstanding']);
    expect(sharedInteractionStore.get('history-session', 'done')?.outcome).toBe('approved');
  });

  it('hydrates visible input metadata outside the newest event window without advancing transcript pagination', async () => {
    const source = { CursorSource: 'runtime', HistoryEpoch: 'epoch', SnapshotSeqId: 293 };
    const requested = { EventType: 'interaction.requested', SessionId: 'history-session', SeqId: 158,
      Content: { interaction_id: 'form-1', kind: 'structured_input', revision: 1,
        request: { presentation: { title: '请输入业务线', a2ui: {
          wire_version: '0.9.1', catalog_digest: 'digest', messages: [{ createSurface: { surfaceId: 'input' } }],
        } }, request_schema: { type: 'object' } } } };
    const resolved = { EventType: 'interaction.resolved', SessionId: 'history-session', SeqId: 289,
      Content: { interaction_id: 'form-1', kind: 'structured_input', revision: 2, outcome: 'submitted' } };
    const listSessionEvents = vi.fn()
      .mockResolvedValueOnce({ ...source, Events: [resolved], Total: 293 })
      .mockResolvedValueOnce({ ...source, Events: [resolved, requested], Total: 2, HasMore: false })
      .mockResolvedValue({ ...source, Events: [], Total: 293 });
    const actions = lifecycle({
      listSessionMessages: vi.fn().mockResolvedValue({ ...source, Messages: [{ MessageId: 'form', Role: 'assistant',
        SeqId: 291, StartSeqId: 128, ToolEvents: [{ Name: 'structured_input', Status: 'completed', ApprovalRequestId: 'form-1' }] }],
      HasMore: false, NextCursor: null }),
      listSessionEvents, getResponseFeedback: vi.fn().mockResolvedValue(null),
    });
    await actions.loadSession('history-session');
    expect(sharedInteractionStore.get('history-session', 'form-1')).toMatchObject({
      title: '请输入业务线', revision: 2, status: 'resolved', outcome: 'submitted', presentation: { a2ui: { wireVersion: '0.9.1' } },
    });
    expect(sharedInteractionStore.listPending('history-session')).toHaveLength(0);
    await actions.loadOlderSessionMessages('history-session');
    expect(listSessionEvents.mock.calls[2]?.[1]).toMatchObject({ offset: 1 });
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

  it('keeps a local draft when the initial list and later refresh return older sessions', async () => {
    let finish!: (value: Awaited<ReturnType<ApiFacade['listSessions']>>) => void;
    const listSessionMessages = vi.fn(async () => ({ Messages: [] }));
    const listSessions = vi.fn(() => new Promise<Awaited<ReturnType<ApiFacade['listSessions']>>>(
      resolve => { finish = resolve; },
    ));
    const actions = lifecycle({ listSessions, listSessionMessages }, true);
    const pending = actions.fetchSessions('agent-a');
    actions.startNewConversation();
    finish({ Sessions: [{ SessionId: 'older' } as Session], Total: 1 });
    await pending;
    expect(useSessionStore.getState().currentSessionId).toBeNull();
    expect(listSessionMessages).not.toHaveBeenCalled();
    expect(useMessageStore.getState().messages).toEqual([]);

    const refreshed = actions.fetchSessions('agent-a');
    finish({ Sessions: [{ SessionId: 'older' } as Session], Total: 1 });
    await refreshed;
    expect(useSessionStore.getState().sessions.map(session => session.SessionId)).toEqual(['older']);
    expect(useSessionStore.getState().currentSessionId).toBeNull();
    expect(listSessionMessages).not.toHaveBeenCalled();

    actions.adoptCreatedSession('first-sent');
    const settled = actions.fetchSessions('agent-a');
    finish({ Sessions: [{ SessionId: 'older' } as Session], Total: 1 });
    await settled;
    expect(useSessionStore.getState().currentSessionId).toBe('first-sent');
  });

  it('ignores a late pagination page after switching Agents', async () => {
    let finish!: (value: Awaited<ReturnType<ApiFacade['listSessions']>>) => void;
    const listSessions = vi.fn(() => new Promise<Awaited<ReturnType<ApiFacade['listSessions']>>>(resolve => { finish = resolve; }));
    const actions = lifecycle({ listSessions });
    useSessionStore.getState().upsertSessions([{ SessionId: 'agent-a-first' } as Session], {
      agentId: 'agent-a', total: 60, page: 1, pageSize: 30,
    });
    const pending = actions.loadMoreSessions();
    expect(listSessions).toHaveBeenCalledWith('agent-a', { page: 2, pageSize: 30 });

    useBootstrapStore.getState().setAgentId('agent-b');
    useSessionStore.getState().resetSessionPagination('agent-b');
    useSessionStore.getState().upsertSessions([{ SessionId: 'agent-b-first' } as Session], {
      agentId: 'agent-b', total: 1, page: 1, pageSize: 30,
    });
    finish({ Sessions: [{ SessionId: 'agent-a-second' } as Session], Total: 60, Page: 2, PageSize: 30 });
    await pending;

    const state = useSessionStore.getState();
    expect(state.sessions.map(session => session.SessionId)).toEqual(['agent-b-first']);
    expect(state.sessionsAgentId).toBe('agent-b');
    expect(state.sessionsTotal).toBe(1);
    expect(state.loadedPages).toEqual(new Set([1]));
    expect(state.hasMoreSessions).toBe(false);
  });

  it.each(['success', 'cancelled', 'failed'] as const)(
    'does not clear the new Agent loading state when an old pagination request ends: %s', async outcome => {
      let finish!: (value: Awaited<ReturnType<ApiFacade['listSessions']>>) => void;
      let fail!: (error: Error) => void;
      const actions = lifecycle({ listSessions: vi.fn(() => new Promise<Awaited<ReturnType<ApiFacade['listSessions']>>>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      })) });
      useSessionStore.getState().upsertSessions([{ SessionId: 'agent-a-first' } as Session], {
        agentId: 'agent-a', total: 60, page: 1, pageSize: 30,
      });
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      const pending = actions.loadMoreSessions();
      useBootstrapStore.getState().setAgentId('agent-b');
      useSessionStore.getState().resetSessionPagination('agent-b');
      useSessionStore.getState().setLoadingSessions(true);
      if (outcome === 'success') finish({ Sessions: [], Total: 60, Page: 2, PageSize: 30 });
      else fail(outcome === 'cancelled' ? new CancelledError() : new Error('offline'));
      await pending;
      expect(useSessionStore.getState().isLoadingSessions).toBe(true);
      errorLog.mockRestore();
    },
  );

  it.each(['first page', 'next page'] as const)(
    'ignores an old %s after switching away and back to the same Agent', async page => {
      let finish!: (value: Awaited<ReturnType<ApiFacade['listSessions']>>) => void;
      const actions = lifecycle({ listSessions: vi.fn(() => new Promise<Awaited<ReturnType<ApiFacade['listSessions']>>>(resolve => { finish = resolve; })) });
      useSessionStore.getState().upsertSessions([{ SessionId: 'agent-a-first' } as Session], {
        agentId: 'agent-a', total: 60, page: 1, pageSize: 30,
      });
      const pending = page === 'first page' ? actions.fetchSessions('agent-a') : actions.loadMoreSessions();
      useBootstrapStore.getState().setAgentId('agent-b');
      useSessionStore.getState().resetSessionPagination('agent-b');
      useBootstrapStore.getState().setAgentId('agent-a');
      useSessionStore.getState().resetSessionPagination('agent-a');
      useSessionStore.getState().setLoadingSessions(true);
      finish({ Sessions: [{ SessionId: 'agent-a-stale' } as Session], Total: 60, Page: page === 'first page' ? 1 : 2, PageSize: 30 });
      await pending;
      expect(useSessionStore.getState().sessions).toEqual([]);
      expect(useSessionStore.getState().loadedPages).toEqual(new Set());
      expect(useSessionStore.getState().isLoadingSessions).toBe(true);
    },
  );

  it.each(['first page', 'next page'] as const)(
    'keeps the newer visit loading when an old %s request is cancelled', async page => {
      let fail!: (error: Error) => void;
      const actions = lifecycle({ listSessions: vi.fn(() => new Promise<Awaited<ReturnType<ApiFacade['listSessions']>>>((_resolve, reject) => { fail = reject; })) });
      useSessionStore.getState().upsertSessions([{ SessionId: 'agent-a-first' } as Session], {
        agentId: 'agent-a', total: 60, page: 1, pageSize: 30,
      });
      const pending = page === 'first page' ? actions.fetchSessions('agent-a') : actions.loadMoreSessions();
      useBootstrapStore.getState().setAgentId('agent-b');
      useSessionStore.getState().resetSessionPagination('agent-b');
      useBootstrapStore.getState().setAgentId('agent-a');
      useSessionStore.getState().resetSessionPagination('agent-a');
      useSessionStore.getState().setLoadingSessions(true);
      fail(new CancelledError());
      await pending;
      expect(useSessionStore.getState().isLoadingSessions).toBe(true);
    },
  );

  it('appends the current Agent page once and clears its loading state', async () => {
    let finish!: (value: Awaited<ReturnType<ApiFacade['listSessions']>>) => void;
    const listSessions = vi.fn(() => new Promise<Awaited<ReturnType<ApiFacade['listSessions']>>>(resolve => { finish = resolve; }));
    const actions = lifecycle({ listSessions });
    useSessionStore.getState().upsertSessions([{ SessionId: 'agent-a-first' } as Session], {
      agentId: 'agent-a', total: 60, page: 1, pageSize: 30,
    });
    const pending = actions.loadMoreSessions();
    expect(useSessionStore.getState().isLoadingSessions).toBe(true);
    await actions.loadMoreSessions();
    expect(listSessions).toHaveBeenCalledTimes(1);
    finish({ Sessions: [{ SessionId: 'agent-a-second' } as Session], Total: 60, Page: 2, PageSize: 30 });
    await pending;

    const state = useSessionStore.getState();
    expect(state.sessions.map(session => session.SessionId)).toEqual(['agent-a-first', 'agent-a-second']);
    expect(state.sessionsAgentId).toBe('agent-a');
    expect(state.loadedPages).toEqual(new Set([1, 2]));
    expect(state.isLoadingSessions).toBe(false);
  });

  it('allows retrying a cancelled current Agent pagination request', async () => {
    const listSessions = vi.fn()
      .mockRejectedValueOnce(new CancelledError())
      .mockResolvedValueOnce({ Sessions: [{ SessionId: 'agent-a-second' } as Session], Total: 60, Page: 2, PageSize: 30 });
    const actions = lifecycle({ listSessions });
    useSessionStore.getState().upsertSessions([{ SessionId: 'agent-a-first' } as Session], {
      agentId: 'agent-a', total: 60, page: 1, pageSize: 30,
    });
    await actions.loadMoreSessions();
    expect(useSessionStore.getState().isLoadingSessions).toBe(false);
    expect(useSessionStore.getState().loadedPages).toEqual(new Set([1]));
    await actions.loadMoreSessions();
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(useSessionStore.getState().loadedPages).toEqual(new Set([1, 2]));
    expect(useSessionStore.getState().isLoadingSessions).toBe(false);
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


it('restores with the completed bootstrap when the list callback captured initial capabilities', async () => {
  useBootstrapStore.getState().setAgentId('agent-a');
  const frames = readFileSync(new URL('./fixtures/a2a_remote_agent/v1/a2a_stream_tool_terminal.jsonl', import.meta.url), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line)).filter(row => row.kind === 'runtime_event').map(row => row.payload);
  const actions = lifecycle({
    listSessionMessages: vi.fn().mockResolvedValue({Messages:[], LatestSeqId:22, HasMore:false, NextCursor:null}),
    listSessionEvents: vi.fn().mockResolvedValue({Events:frames.map(e=>({SeqId:e.seq, EventType:'runtime_event', Content:{runtime_event:e}})), Total:frames.length}),
    getResponseFeedback: vi.fn().mockResolvedValue(null),
  });
  useBootstrapStore.getState().setCapabilities({RunLifecycle:{Enabled:false}, ConversationSurface:{
    apiVersion:'conversation.ksadk.io/v1', kind:'ConversationSurface', surfaceId:'runtime:agent-a',
    sessionId:'new-session', providerRef:'adk', inputs:[{name:'ksadk.presentation',mode:'native'}],
    outputs:[{name:'agent.block',mode:'native'}],
  }} as UiCapabilities);
  await actions.loadSession('profile-session');
  expect(useMessageStore.getState().messages.filter(message=>message.agentBlock)).toHaveLength(1);
});
