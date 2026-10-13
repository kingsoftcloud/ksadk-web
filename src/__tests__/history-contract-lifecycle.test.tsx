import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionLifecycle } from '../hooks/useSessionLifecycle.js';
import { ApiError } from '../api/client.js';
import { useSessionStore } from '../stores/session.js';
import { useMessageStore } from '../stores/message.js';
import { useBootstrapStore } from '../stores/bootstrap.js';
import type { ApiFacade } from '../core/api/types.js';
import type { UiCapabilities } from '../types/capabilities.js';

const first = {
  Messages: [{ MessageId: 'old', Role: 'assistant' as const, Content: { text: 'Old history' }, SeqId: 9 }],
  LatestSeqId: 12, HasMore: true, NextCursor: 8,
  DataSource: 'control_fallback', Degraded: true, CursorSource: 'control',
  CursorCompatibleWithRuntime: false, SessionContractVersion: 2,
  HistoryEpoch: 'epoch-1', PersistenceDegraded: true, SnapshotSeqId: 0,
};
const events = { Events: [], Total: 0 };
const reloadRequired = () => new ApiError(409, 'reload', { Code: 409, ReasonCode: 'HISTORY_RELOAD_REQUIRED', Data: null });

function mount(api: Partial<ApiFacade>) {
  let actions!: ReturnType<typeof useSessionLifecycle>;
  function Probe() {
    actions = useSessionLifecycle({ agentId: 'agent-a', currentSessionId: 's',
      isMobile: false, uiCapabilities: { RunLifecycle: { Enabled: false } } as UiCapabilities,
      api: api as ApiFacade, resetCompaction: () => {}, restoreSession: false });
    return null;
  }
  renderToString(createElement(Probe));
  return actions;
}

describe('history continuation and recovery', () => {
  beforeEach(() => {
    useBootstrapStore.getState().setAgentId('agent-a');
    useSessionStore.getState().clearSessionMessageHistory();
    useSessionStore.getState().setCurrentSessionId('s');
    useMessageStore.getState().setMessages([]);
  });

  it('carries source, epoch and zero snapshot through an empty visible continuation page', async () => {
    const listSessionMessages = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce({
      Messages: [], LatestSeqId: 12, HasMore: true, NextCursor: 4,
      CursorSource: 'control', HistoryEpoch: 'epoch-1',
    });
    const actions = mount({ listSessionMessages, listSessionEvents: vi.fn().mockResolvedValue(events) });
    await actions.loadSession('s');
    await actions.loadOlderSessionMessages('s');
    expect(listSessionMessages).toHaveBeenNthCalledWith(2, 's', expect.objectContaining({
      beforeSeqId: 8, cursorSource: 'control', historyEpoch: 'epoch-1', snapshotSeqId: 0,
    }));
    expect(useSessionStore.getState().messageHistory.s).toMatchObject({
      nextCursor: 4, hasMore: true, snapshotSeqId: 0, persistenceDegraded: true,
    });
    expect(useMessageStore.getState().messages.map(item => item.content)).toContain('Old history');
  });

  it('does not merge runtime events into a control-source message history', async () => {
    const listSessionEvents = vi.fn().mockResolvedValue({ Events: [], Total: 4,
      CursorSource: 'runtime', HistoryEpoch: 'runtime-epoch', SnapshotSeqId: 0 });
    const actions = mount({ listSessionMessages: vi.fn().mockResolvedValue({
      ...first, HasMore: false, NextCursor: null,
    }), listSessionEvents });
    await actions.loadSession('s');
    expect(useSessionStore.getState().messageHistory.s.hasMore).toBe(false);
    await actions.loadOlderSessionMessages('s');
    expect(listSessionEvents).toHaveBeenCalledTimes(1);
    expect(useMessageStore.getState().messages.map(item => item.content)).toEqual(['Old history']);
  });

  it('reloads the first page once after 409 and replaces the old transcript only on success', async () => {
    const replacement = { ...first, Messages: [{ MessageId: 'new', Role: 'assistant' as const,
      Content: { text: 'New history' }, SeqId: 2 }], NextCursor: null, HasMore: false,
      CursorSource: 'runtime', HistoryEpoch: 'epoch-2', SnapshotSeqId: 2, PersistenceDegraded: false };
    const listSessionMessages = vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(reloadRequired())
      .mockResolvedValueOnce(replacement);
    const actions = mount({ listSessionMessages, listSessionEvents: vi.fn().mockResolvedValue(events) });
    await actions.loadSession('s');
    await actions.loadOlderSessionMessages('s');
    expect(listSessionMessages).toHaveBeenCalledTimes(3);
    expect(listSessionMessages.mock.calls[2][1]).not.toHaveProperty('beforeSeqId');
    expect(listSessionMessages.mock.calls[2][1]).not.toHaveProperty('snapshotSeqId');
    expect(useMessageStore.getState().messages.map(item => item.content)).toEqual(['New history']);
    expect(useSessionStore.getState().messageHistory.s).toMatchObject({
      cursorSource: 'runtime', historyEpoch: 'epoch-2', snapshotSeqId: 2, persistenceDegraded: false,
    });
  });

  it('keeps the visible old transcript and clears the stale cursor if the one reload fails', async () => {
    const listSessionMessages = vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(reloadRequired())
      .mockRejectedValueOnce(reloadRequired());
    const actions = mount({ listSessionMessages, listSessionEvents: vi.fn().mockResolvedValue(events) });
    await actions.loadSession('s');
    await actions.loadOlderSessionMessages('s');
    expect(listSessionMessages).toHaveBeenCalledTimes(3);
    expect(useMessageStore.getState().messages.map(item => item.content)).toEqual(['Old history']);
    expect(useSessionStore.getState().messageHistory.s).toMatchObject({
      nextCursor: null, hasMore: false, error: expect.stringContaining('原有消息已保留'),
    });
    expect(useSessionStore.getState().messageHistory.s.cursorSource).toBeUndefined();
    expect(useSessionStore.getState().messageHistory.s.snapshotSeqId).toBeUndefined();
  });

  it('does not commit a reload response that resolves after its caller aborts', async () => {
    let finish!: (value: typeof first) => void;
    const listSessionMessages = vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(reloadRequired())
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const actions = mount({ listSessionMessages, listSessionEvents: vi.fn().mockResolvedValue(events) });
    await actions.loadSession('s');
    const controller = new AbortController();
    const pending = actions.loadOlderSessionMessages('s', controller.signal);
    await vi.waitFor(() => expect(listSessionMessages).toHaveBeenCalledTimes(3));
    controller.abort();
    finish({ ...first, Messages: [{ MessageId: 'late', Role: 'assistant',
      Content: { text: 'Late replacement' }, SeqId: 2 }] });
    await pending;
    expect(useMessageStore.getState().messages.map(item => item.content)).toEqual(['Old history']);
    expect(useSessionStore.getState().messageHistory.s.nextCursor).toBeNull();
  });

  it('does not retry a projection-budget failure with the same parameters', async () => {
    const listSessionMessages = vi.fn().mockRejectedValue(new ApiError(422, 'budget', {
      Code: 422, ReasonCode: 'HISTORY_PROJECTION_BUDGET_EXCEEDED', Data: null,
    }));
    const actions = mount({ listSessionMessages });
    await actions.loadSession('s');
    expect(listSessionMessages).toHaveBeenCalledTimes(1);
  });

  it('ignores an older page resolved after the selected session changes', async () => {
    let finish!: (value: typeof first) => void;
    const listSessionMessages = vi.fn().mockResolvedValueOnce(first)
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const actions = mount({ listSessionMessages, listSessionEvents: vi.fn().mockResolvedValue(events) });
    await actions.loadSession('s');
    const pending = actions.loadOlderSessionMessages('s');
    actions.startNewConversation();
    finish({ ...first, Messages: [{ MessageId: 'stale', Role: 'assistant', Content: { text: 'Stale' }, SeqId: 1 }] });
    await pending;
    expect(useSessionStore.getState().currentSessionId).toBeNull();
    expect(useMessageStore.getState().messages).toEqual([]);
  });
  it('keeps streaming updates and a new turn when a delayed older page arrives', async () => {
    let finish!: (value: typeof first) => void;
    const latest = { ...first, Messages: [
      { MessageId: 'q2', Role: 'user' as const, Content: { text: 'Q2' }, SeqId: 8, InvocationId: 'r2', Timestamp: 10 },
      { MessageId: 'a2', Role: 'assistant' as const, Content: { text: 'partial' }, SeqId: 9, InvocationId: 'r2', Timestamp: 1 },
    ] };
    const api = { listSessionMessages: vi.fn().mockResolvedValueOnce(latest)
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })),
      listSessionEvents: vi.fn().mockResolvedValue(events) };
    const actions = mount(api);
    await actions.loadSession('s');
    // A live update before the page request is also newer than the fixed history snapshot.
    useMessageStore.getState().patchMessages(rows => rows.map(row => row.id === 'a2'
      ? { ...row, content: 'stream before request' } : row));
    const pending = actions.loadOlderSessionMessages('s');
    actions.adoptCreatedSession('s', true);
    expect(useSessionStore.getState().messageHistory.s.nextCursor).toBe(8);
    useMessageStore.getState().patchMessages(rows => [...rows.map(row => row.id === 'a2'
      ? { ...row, content: 'complete live answer' } : row),
      { id: 'q3', role: 'user', content: 'Q3', timestamp: 0, invocationId: 'r3' }]);
    finish({ ...first, HasMore: false, NextCursor: null, Messages: [
      { MessageId: 'q1', Role: 'user', Content: { text: 'Q1' }, SeqId: 1, Timestamp: 200 },
      { MessageId: 'a1', Role: 'assistant', Content: { text: 'A1' }, SeqId: 2, Timestamp: 300 },
    ] } as typeof first);
    await pending;
    expect(useMessageStore.getState().messages.map(row => row.content))
      .toEqual(['Q1', 'A1', 'Q2', 'complete live answer', 'Q3']);
  });

  it('keeps a live message arriving during the initial event-page read', async () => {
    let finish!: (value: typeof events) => void;
    const api = { listSessionMessages: vi.fn().mockResolvedValue(first),
      listSessionEvents: vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })) };
    const actions = mount(api);
    const pending = actions.loadSession('s');
    await vi.waitFor(() => expect(api.listSessionEvents).toHaveBeenCalled());
    useMessageStore.getState().patchMessages(rows => [...rows,
      { id: 'live', role: 'model', content: 'new live output', timestamp: 0, invocationId: 'live-run' }]);
    finish(events); await pending;
    expect(useMessageStore.getState().messages.map(row => row.content)).toEqual(['Old history', 'new live output']);
  });

  it('lets a fresh session read replace a previously streamed stale snapshot', async () => {
    const fresh = { ...first, Messages: [{ ...first.Messages[0], Content: { text: 'durable final answer' } }] };
    const actions = mount({ listSessionMessages: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(fresh),
      listSessionEvents: vi.fn().mockResolvedValue(events) });
    await actions.loadSession('s');
    useMessageStore.getState().patchMessages(rows => rows.map(row => ({ ...row, content: 'old stream prefix' })));
    await actions.loadSession('s');
    expect(useMessageStore.getState().messages.map(row => row.content)).toEqual(['durable final answer']);
  });

});
