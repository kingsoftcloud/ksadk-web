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

  it('reassembles repeated legacy text deltas across an opaque page boundary and replaces them with the final snapshot on refresh', async () => {
    const delta = (seq: number, type = 'assistant_stream_delta', text = '哈') => ({
      ItemId: 'e' + seq, SeqId: seq, EventType: type, InvocationId: 'r',
      Event: { SeqId: seq, EventId: 'e' + seq, SessionId: 's', InvocationId: 'r', EventType: type, Content: { text } },
    });
    const page = { HistoryView: 'items-v1', HistoryEpoch: 'epoch', SnapshotSeqId: 3,
      CursorSource: 'runtime', NextCursor: null, Messages: [], LatestSeqId: 3, HasMore: true,
      Items: [delta(3)], NextItemCursor: 'older/3' };
    const read = vi.fn().mockResolvedValueOnce(page).mockRejectedValueOnce(new ApiError(503, 'retry'))
      .mockResolvedValueOnce({ ...page, HasMore: false, NextItemCursor: null, Items: [delta(1), delta(2)] })
      .mockResolvedValueOnce({ ...page, HasMore: false, NextItemCursor: null, SnapshotSeqId: 4,
        Items: [delta(1), delta(2), delta(3), delta(4, 'assistant_message', '哈哈哈！')] });
    const listSessionEvents = vi.fn();
    const actions = mount({ listSessionMessages: read, listSessionEvents });
    await actions.loadSession('s');
    expect(useMessageStore.getState().messages.map(row => row.content)).toEqual(['哈']);
    await actions.loadOlderSessionMessages('s');
    expect(useSessionStore.getState().messageHistory.s.nextItemCursor).toBe('older/3');
    await actions.loadOlderSessionMessages('s');
    expect(read.mock.calls[2][1]).toMatchObject({ historyView: 'items-v1', itemCursor: 'older/3', snapshotSeqId: 3 });
    expect(useMessageStore.getState().messages.map(row => row.content)).toEqual(['哈哈哈']);
    expect(useSessionStore.getState().messageHistory.s.hasMore).toBe(false);
    await actions.loadSession('s');
    expect(useMessageStore.getState().messages.map(row => row.content)).toEqual(['哈哈哈！']);
    expect(listSessionEvents).not.toHaveBeenCalled();
  });

  it('bridges an older giant invocation into a pinned Messages chain without replacing the rendered suffix', async () => {
    const pin = { CursorSource: 'runtime', HistoryEpoch: 'epoch', SnapshotSeqId: 100 };
    const legacy = { ...first, ...pin, DataSource: 'runtime', NextCursor: 9 };
    const page = (seq: number, cursor: string | null) => ({ ...pin, HistoryView: 'items-v1',
      LatestSeqId: seq, Messages: [], HasMore: Boolean(cursor), NextItemCursor: cursor, NextCursor: null,
      Items: [{ ItemId: 'source-' + seq, SeqId: seq, EventType: 'user_message',
        Event: { SeqId: seq, SessionId: 's', EventId: 'source-' + seq, EventType: 'user_message',
          Content: { parts: [{ text: 'entry-' + seq }] } } }] });
    const read = vi.fn().mockResolvedValueOnce(legacy).mockResolvedValueOnce(page(8, 'before-8'))
      .mockRejectedValueOnce(new ApiError(504, 'timeout')).mockResolvedValueOnce(page(1, null));
    const detail = vi.fn().mockResolvedValueOnce({ ...pin, Total: 60, Events: [{ SeqId: 9, EventType: 'progress' }] })
      .mockResolvedValueOnce({ ...pin, Total: 60, Events: [] });
    const actions = mount({ listSessionMessages: read, listSessionEvents: detail });
    const contents = () => useMessageStore.getState().messages.map(m => m.content);
    await actions.loadSession('s');
    await actions.loadOlderSessionMessages('s');
    expect(read.mock.calls[1][1]).toMatchObject({ beforeSeqId: 9, historyView: 'items-v1', historyEpoch: 'epoch' });
    expect(contents()).toEqual(['entry-8', 'Old history']);
    await actions.loadOlderSessionMessages('s');
    expect(contents()).toEqual(['entry-8', 'Old history']);
    expect(useSessionStore.getState().messageHistory.s).toMatchObject({ retryOlderPage: true, nextItemCursor: 'before-8' });
    await actions.loadOlderSessionMessages('s');
    expect(read.mock.calls[3][1]).toMatchObject({ itemCursor: 'before-8', historyEpoch: 'epoch' });
    expect(contents()).toEqual(['entry-1', 'entry-8', 'Old history']);
    expect(useSessionStore.getState().messageHistory.s).toMatchObject({ retryOlderPage: false, hasMore: false });
    expect(detail).toHaveBeenCalledTimes(2);
  });

  it('paints a deferred item before fetching its unicode body and validates every chunk', async () => {
    const page = { HistoryView: 'items-v1', HistoryEpoch: 'epoch', CursorSource: 'runtime', SnapshotSeqId: 2,
      NextCursor: null, NextItemCursor: null, Messages: [], LatestSeqId: 2, HasMore: false };
    const event = { SessionId: 's', SeqId: 2, EventType: 'assistant_message', EventId: 'id' };
    const read = vi.fn().mockResolvedValueOnce({ ...page, Items: [
      { SeqId: 2, ItemId: 'id', EventType: event.EventType, ContentRef: { SeqId: 2 }, Event: event }] })
      .mockResolvedValueOnce({ ...page, ContentSeqId: 2, ContentChunk: '[{"text":"第一段', NextContentOffset: 12 })
      .mockResolvedValueOnce({ ...page, ContentSeqId: 2, ContentChunk: '🙂第二段"},{}]', NextContentOffset: null });
    const actions = mount({ listSessionMessages: read });
    await actions.loadSession('s');
    expect(read).toHaveBeenCalledTimes(1);
    await expect(useMessageStore.getState().messages[0].readHistoryContent!(new AbortController().signal))
      .resolves.toBe('第一段🙂第二段');
    expect(read.mock.calls.slice(1).map(([, options]) => options.contentOffset)).toEqual([0, 12]);
  });

  it('keeps the original user input and reply when refreshing history fails', async () => {
    const input = { MessageId: 'original-user', Role: 'user' as const,
      Content: { text: 'Original user question' }, SeqId: 8, InvocationId: 'turn-1' };
    const page = { ...first, HasMore: false, NextCursor: null,
      Messages: [input, { ...first.Messages[0], InvocationId: 'turn-1' }] };
    const read = vi.fn().mockResolvedValueOnce(page).mockRejectedValue(new ApiError(504, 'unavailable'));
    const actions = mount({ listSessionMessages: read, listSessionEvents: vi.fn().mockResolvedValue(events) });
    await actions.loadSession('s');
    const original = structuredClone(useMessageStore.getState().messages);
    await actions.loadSession('s');
    expect(useMessageStore.getState().messages).toEqual(original);
    expect(original.filter(message => message.role === 'user').map(message => message.content))
      .toEqual(['Original user question']);
    expect(useSessionStore.getState().messageHistory.s.error).toBeTruthy();
  });

  it('loads bounded event detail pages through the exact total while retaining readable text', async () => {
    const page = { ...first, CursorSource: 'runtime', DataSource: 'runtime',
      HistoryEpoch: 'durable', SnapshotSeqId: 150, HasMore: false, NextCursor: null };
    const listSessionEvents = vi.fn(async (_session: string, options?: { offset?: number; limit?: number }) => {
      const offset = options?.offset || 0;
      const count = Math.min(options?.limit || 0, 150 - offset);
      return { Events: Array.from({ length: count }, (_, index) => ({
        EventId: `debug-${offset + index}`, SessionId: 's', EventType: 'diagnostic',
        SeqId: 150 - offset - index, Content: {},
      })), Total: 150, CursorSource: 'runtime', HistoryEpoch: 'durable', SnapshotSeqId: 150 };
    });
    const actions = mount({ listSessionMessages: vi.fn().mockResolvedValue(page), listSessionEvents });
    await actions.loadSession('s');
    await actions.loadOlderSessionMessages('s');
    await actions.loadOlderSessionMessages('s');
    expect(listSessionEvents.mock.calls.map(([, options]) => options)).toEqual([
      expect.objectContaining({ offset: 0, limit: 64 }),
      expect.objectContaining({ offset: 64, limit: 64, historyEpoch: 'durable', snapshotSeqId: 150 }),
      expect.objectContaining({ offset: 128, limit: 64, historyEpoch: 'durable', snapshotSeqId: 150 }),
    ]);
    expect(useSessionStore.getState().messageHistory.s.hasMore).toBe(false);
    expect(useMessageStore.getState().messages.map(message => message.content)).toEqual(['Old history']);
  });

  it.each([429, 502, 503, 504])('keeps a successful message page on detail error %i and retries only the unchanged detail offset', async (code) => {
    const detail = { Events: [{ EventId: 'd1', SessionId: 's', EventType: 'diagnostic', SeqId: 12, Content: {} }],
      Total: 2, CursorSource: 'control', HistoryEpoch: 'epoch-1', SnapshotSeqId: 0 };
    const listSessionEvents = vi.fn().mockResolvedValueOnce(detail)
      .mockRejectedValueOnce(new ApiError(code, 'unavailable'))
      .mockResolvedValueOnce({ ...detail, Events: [{ ...detail.Events[0], EventId: 'd0', SeqId: 1 }] });
    const listSessionMessages = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce({ ...first,
      Messages: [{ MessageId: 'older', Role: 'assistant', Content: { text: 'Older body' }, SeqId: 2 }],
      HasMore: false, NextCursor: null });
    const actions = mount({ listSessionMessages, listSessionEvents });
    await actions.loadSession('s');
    await actions.loadOlderSessionMessages('s');
    expect(useMessageStore.getState().messages.map(row => row.content)).toEqual(['Older body', 'Old history']);
    expect(useSessionStore.getState().messageHistory.s).toMatchObject({ nextCursor: null, hasMore: true,
      error: expect.stringContaining('部分事件详情') });
    expect(actions.historySearchSnapshot().error).toBeTruthy();
    await actions.loadOlderSessionMessages('s');
    expect(listSessionMessages).toHaveBeenCalledTimes(2);
    expect(listSessionEvents.mock.calls.slice(1).map(([, options]) => options.offset)).toEqual([1, 1]);
    expect(useSessionStore.getState().messageHistory.s).toMatchObject({ hasMore: false, error: undefined });
    expect(actions.historySearchSnapshot().error).toBeUndefined();
  });

  it.each([401, 403, 404, 409])('does not apply a message page when detail authorization/source fails with %i', async (code) => {
    const listSessionEvents = vi.fn().mockResolvedValueOnce({ Events: [{ EventId: 'd', EventType: 'diagnostic', Content: {} }],
      Total: 2, CursorSource: 'control', HistoryEpoch: 'epoch-1', SnapshotSeqId: 0 })
      .mockRejectedValueOnce(new ApiError(code, 'denied'));
    const listSessionMessages = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce({ ...first,
      Messages: [{ MessageId: 'denied', Role: 'assistant', Content: { text: 'Must not merge' }, SeqId: 1 }] });
    const actions = mount({ listSessionMessages, listSessionEvents });
    await actions.loadSession('s');
    await actions.loadOlderSessionMessages('s');
    expect(useMessageStore.getState().messages.map(row => row.content)).toEqual(['Old history']);
    expect(useSessionStore.getState().messageHistory.s.nextCursor).toBe(8);
  });

  it('reloads once for a detail epoch conflict before applying the successful message page', async () => {
    const detail = { Events: [{ EventId: 'd', EventType: 'diagnostic', Content: {} }],
      Total: 2, CursorSource: 'control', HistoryEpoch: 'epoch-1', SnapshotSeqId: 0 };
    const listSessionEvents = vi.fn().mockResolvedValueOnce(detail)
      .mockRejectedValueOnce(reloadRequired()).mockResolvedValueOnce(events);
    const listSessionMessages = vi.fn().mockResolvedValueOnce(first)
      .mockResolvedValueOnce({ ...first, Messages: [{ ...first.Messages[0], MessageId: 'stale',
        Content: { text: 'Stale page' } }] })
      .mockResolvedValueOnce({ ...first, HasMore: false, NextCursor: null,
        Messages: [{ ...first.Messages[0], MessageId: 'fresh', Content: { text: 'Fresh page' } }] });
    const actions = mount({ listSessionMessages, listSessionEvents });
    await actions.loadSession('s');
    await actions.loadOlderSessionMessages('s');
    expect(listSessionMessages).toHaveBeenCalledTimes(3);
    expect(listSessionMessages.mock.calls[2][1]).not.toHaveProperty('beforeSeqId');
    expect(useMessageStore.getState().messages.map(row => row.content)).toEqual(['Fresh page']);
  });

  it('ignores delayed detail failures and successful pages after switching sessions', async () => {
    let fail!: (error: Error) => void;
    const listSessionEvents = vi.fn().mockResolvedValueOnce({ Events: [{ EventId: 'd', Content: {} }],
      Total: 2, CursorSource: 'control', HistoryEpoch: 'epoch-1', SnapshotSeqId: 0 })
      .mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    const actions = mount({ listSessionMessages: vi.fn().mockResolvedValue(first), listSessionEvents });
    await actions.loadSession('s');
    const pending = actions.loadOlderSessionMessages('s');
    actions.startNewConversation();
    fail(new ApiError(504, 'late timeout'));
    await pending;
    expect(useMessageStore.getState().messages).toEqual([]);
    expect(actions.historySearchSnapshot().error).toBeUndefined();
  });

  it('records a cold history failure visibly without pretending the session is empty', async () => {
    const read = vi.fn().mockRejectedValue(new ApiError(504, 'timeout'));
    await mount({ listSessionMessages: read }).loadSession('s');
    expect(read).toHaveBeenCalledOnce();
    expect(useSessionStore.getState().messageHistory.s).toMatchObject({
      isLoadingInitial: false, preparing: false, error: expect.stringContaining('读取失败'),
    });
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

describe('preparing older history', () => {
  beforeEach(() => {
    useBootstrapStore.getState().setAgentId('agent-a');
    useSessionStore.getState().clearSessionMessageHistory();
    useSessionStore.getState().setCurrentSessionId('s');
    useMessageStore.getState().setMessages([]);
  });
  it('retains the current transcript and records pagination failure for retry', async () => {
    const listSessionMessages = vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(new ApiError(504, 'timeout'));
    const actions = mount({ listSessionMessages, listSessionEvents: vi.fn().mockResolvedValue(events) });
    await actions.loadSession('s');
    await actions.loadOlderSessionMessages('s');
    expect(useSessionStore.getState().messageHistory.s).toMatchObject({error: 'timeout', nextCursor: 8, preparing: false});
    expect(useMessageStore.getState().messages.map(x => x.content)).toEqual(['Old history']);
    expect(listSessionMessages).toHaveBeenCalledTimes(2);
  });
  it('cancels pending preparation when another session is selected', async () => {
    vi.useFakeTimers();
    try {
      const listSessionMessages = vi.fn().mockResolvedValueOnce(first).mockRejectedValue(new ApiError(503, 'preparing', {
        ReasonCode: 'HISTORY_PREPARING', Code: 503,
      }));
      const actions = mount({ listSessionMessages, listSessionEvents: vi.fn().mockResolvedValue(events) });
      await actions.loadSession('s');
      const pending = actions.loadOlderSessionMessages('s');
      await vi.advanceTimersByTimeAsync(0);
      expect(useSessionStore.getState().messageHistory.s.preparing).toBe(true);
      actions.startNewConversation();
      await vi.advanceTimersByTimeAsync(2000);
      await pending;
      expect(listSessionMessages).toHaveBeenCalledTimes(2);
      expect(useMessageStore.getState().messages).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});

it('restores two same-name tool results, a resolved legacy approval, and an accepted user input exactly once', async () => {
  const make = (seq: number, type: string, metadata = {}, content = {}) => ({
    ItemId: 'e-' + seq, SeqId: seq, EventType: type, InvocationId: 'r',
    Event: { SeqId: seq, EventId: 'e-' + seq, EventType: type, InvocationId: 'r', SessionId: 's',
      Content: content, Metadata: metadata },
  });
  const page = { HistoryView: 'items-v1', SnapshotSeqId: 9, HistoryEpoch: 'epoch', CursorSource: 'runtime',
    NextCursor: null, Messages: [], LatestSeqId: 9 };
  const read = vi.fn().mockResolvedValueOnce({ ...page, HasMore: true, NextItemCursor: 'older', Items: [
    make(6, 'tool_result', { call_id: 'b', tool_name: 'search', tool_output: 'result-b' }),
    make(7, 'approval_response', { resume_input: { approval_request_id: 'approval', approve: true } }),
    make(8, 'tool_result', { call_id: 'a', tool_name: 'search', tool_output: 'result-a' }),
    make(9, 'assistant_message', {}, { text: 'answer' }),
  ] }).mockResolvedValueOnce({ ...page, HasMore: false, NextItemCursor: null, Items: [
    { ...make(1, 'control.accepted'), InboxInput: { CommandId: 'cmd', Text: 'question' } },
    { ...make(2, 'user_message', {}, { text: 'question' }), InputCommandId: 'cmd' },
    make(3, 'approval_request', { interrupt_info: { id: 'approval', tool_name: 'publish' } }),
    make(4, 'tool_call', { call_id: 'a', tool_name: 'search', tool_args: 'args-a' }),
    make(5, 'tool_call', { call_id: 'b', tool_name: 'search', tool_args: 'args-b' }),
  ] });
  const actions = mount({ listSessionMessages: read });
  await actions.loadSession('s');
  await actions.loadOlderSessionMessages('s');
  const transcript = useMessageStore.getState().messages;
  expect(transcript.filter(row => row.role === 'user').map(row => row.content)).toEqual(['question']);
  expect(transcript.filter(row => row.content === 'answer')).toHaveLength(1);
  const tools = transcript.flatMap(row => Object.values(row.tools || {}));
  expect(tools.filter(row => row.name === 'search')).toHaveLength(2);
  expect(tools).toEqual(expect.arrayContaining(['a', 'b'].map(id => expect.objectContaining({
    name: 'search', callId: id, args: 'args-' + id, output: 'result-' + id, status: 'completed',
  }))));
  expect(tools).toContainEqual(expect.objectContaining({ approvalRequestId: 'approval', approvalStatus: 'approved' }));
});
