import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { useSessionLifecycle } from '../hooks/useSessionLifecycle.js';
import { ApiError } from '../api/client.js';
import { useSessionStore } from '../stores/session.js';
import { useMessageStore } from '../stores/message.js';
import { useBootstrapStore } from '../stores/bootstrap.js';
import { mergeHistoryWithLive } from '../utils/transcript-order.js';
import type { ApiFacade } from '../core/api/types.js';
import type { UiCapabilities } from '../types/capabilities.js';
import type { Message } from '../components/chat/types.js';
import type { ListSessionMessagesResponse } from '../api/messages.js';
const first: ListSessionMessagesResponse = {
  Messages: [
    {
      MessageId: 'old',
      Role: 'assistant',
      Content: { text: 'Old history' },
      SeqId: 9,
    },
  ],
  LatestSeqId: 12,
  HasMore: true,
  NextCursor: 8,
  CursorSource: 'runtime',
  HistoryEpoch: 'e1',
  SnapshotSeqId: 12,
};
const events = { Events: [], Total: 0 };
function mount(api: Partial<ApiFacade>) {
  let actions!: ReturnType<typeof useSessionLifecycle>;
  function Probe() {
    actions = useSessionLifecycle({
      agentId: 'a',
      currentSessionId: 's',
      isMobile: false,
      uiCapabilities: { RunLifecycle: { Enabled: false } } as UiCapabilities,
      api: {
        getSession: async () => ({
          SessionId: 's',
          ActiveRunStatus: 'completed',
        }),
        ...api,
      } as ApiFacade,
      resetCompaction: () => {},
      restoreSession: false,
    });
    return null;
  }
  renderToString(createElement(Probe));
  return actions;
}
beforeEach(() => {
  useBootstrapStore.getState().setAgentId('a');
  useSessionStore.getState().clearSessionMessageHistory();
  useSessionStore.getState().setCurrentSessionId('s');
  useMessageStore.getState().setMessages([]);
});
it('retains new live input and reply received while automatic epoch reload is in flight', async () => {
  let finish!: (value: typeof first) => void;
  const read = vi
    .fn()
    .mockResolvedValueOnce(first)
    .mockRejectedValueOnce(
      new ApiError(409, 'reload', { ReasonCode: 'HISTORY_RELOAD_REQUIRED' }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const actions = mount({
    listSessionMessages: read,
    listSessionEvents: vi.fn().mockResolvedValue(events),
  });
  await actions.loadSession('s');
  const pending = actions.loadOlderSessionMessages('s');
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  useMessageStore
    .getState()
    .patchMessages((rows) => [
      ...rows,
      {
        id: 'new-q',
        role: 'user',
        content: 'New question',
        timestamp: 1,
        invocationId: 'new-run',
      },
      {
        id: 'new-a',
        role: 'model',
        content: 'New live answer',
        timestamp: 2,
        invocationId: 'new-run',
      },
    ]);
  finish({
    ...first,
    HistoryEpoch: 'e2',
    HasMore: false,
    NextCursor: null,
    Messages: [
      {
        MessageId: 'fresh',
        Role: 'assistant',
        Content: { text: 'Fresh history' },
        SeqId: 2,
      },
    ],
  });
  await pending;
  expect(useMessageStore.getState().messages.map((row) => row.content)).toEqual(
    ['Fresh history', 'New question', 'New live answer'],
  );
});
it('does not treat feedback as a full live replacement of newly hydrated items from the same run', () => {
  const old: Message = {
    id: 'a-last',
    role: 'model',
    content: 'Final output',
    timestamp: 1,
    invocationId: 'r',
    historyOrder: { seq: 9 },
  };
  const older: Message = {
    id: 'a-earlier',
    role: 'model',
    content: 'Earlier assistant item',
    timestamp: 0,
    invocationId: 'r',
    historyOrder: { seq: 2 },
  };
  const feedback = { ...old, feedback: { rating: 'up' as const } };
  const merged = mergeHistoryWithLive([older, old], [old], [feedback]);
  expect(merged.map((row) => row.id)).toEqual(['a-earlier', 'a-last']);
  expect(merged[1].feedback?.rating).toBe('up');
});
it('retains the load-older lock while the history preparation poll is active', async () => {
  const controller = new AbortController();
  const read = vi
    .fn()
    .mockResolvedValueOnce(first)
    .mockRejectedValue(
      new ApiError(503, 'preparing', { ReasonCode: 'HISTORY_PREPARING' }),
    );
  const actions = mount({
    listSessionMessages: read,
    listSessionEvents: vi.fn().mockResolvedValue(events),
  });
  await actions.loadSession('s');
  const pending = actions
    .loadOlderSessionMessages('s', controller.signal)
    .catch(() => {});
  await vi.waitFor(() =>
    expect(useSessionStore.getState().messageHistory.s.preparing).toBe(true),
  );
  const locked = useSessionStore.getState().messageHistory.s.isLoadingOlder;
  const duplicate = actions
    .loadOlderSessionMessages('s', controller.signal)
    .catch(() => {});
  const readCount = read.mock.calls.length;
  controller.abort();
  await Promise.all([pending, duplicate]);
  expect({ locked, readCount }).toEqual({ locked: true, readCount: 2 });
});

it.each([false, true])(
  'keeps newly paged tool details with saved feedback=%s',
  async (hasFeedback) => {
    const run = 'r';
    const rr = (seq: number, runtimeEvent: Record<string, unknown>) => ({
      SeqId: seq,
      EventId: `e${seq}`,
      SessionId: 's',
      EventType: String(runtimeEvent.event_type),
      InvocationId: run,
      Content: {
        runtime_event: {
          schema_version: 2,
          family: 'runtime',
          run_id: run,
          scope_id: 'scope',
          event_id: `e${seq}`,
          seq,
          source: { framework: 'adk', metadata: {} },
          ...runtimeEvent,
        },
      },
    });
    const records = [
      rr(1, { event_type: 'run.started' }),
      rr(2, {
        event_type: 'item.started',
        item_id: 'tool',
        item_kind: 'tool_call',
        initial: { parts: [] },
      }),
      rr(3, {
        event_type: 'item.completed',
        item_id: 'tool',
        item_kind: 'tool_call',
        snapshot: {
          parts: [
            {
              content_type: 'tool_call',
              part_id: 'call',
              call_id: 'lookup-1',
              name: 'lookup',
              arguments: {},
            },
            {
              content_type: 'tool_result',
              part_id: 'result',
              call_id: 'lookup-1',
              result: 42,
            },
          ],
        },
      }),
      rr(4, {
        event_type: 'item.completed',
        item_id: 'answer',
        item_kind: 'message',
        snapshot: {
          parts: [{ content_type: 'text', part_id: 'text', text: 'Answer 42' }],
        },
      }),
      rr(5, { event_type: 'run.completed' }),
    ];
    const metadata = {
      CursorSource: 'runtime',
      HistoryEpoch: 'e1',
      SnapshotSeqId: 12,
    };
    const listSessionEvents = vi
      .fn()
      .mockResolvedValueOnce({ ...metadata, Events: [records[4]], Total: 5 })
      .mockResolvedValueOnce({
        ...metadata,
        Events: records.slice(0, 4),
        Total: 5,
      });
    const actions = mount({
      listSessionMessages: vi.fn().mockResolvedValue({
        ...first,
        HasMore: false,
        NextCursor: null,
        Messages: [
          {
            MessageId: 'q',
            Role: 'user',
            Content: { text: 'Question' },
            SeqId: 1,
            InvocationId: run,
          },
          {
            MessageId: 'a',
            Role: 'assistant',
            Content: { text: 'Answer 42' },
            SeqId: 4,
            InvocationId: run,
            ResponseId: 'resp',
          },
        ],
      }),
      listSessionEvents,
      getResponseFeedback: vi
        .fn()
        .mockResolvedValue({ Feedback: hasFeedback ? { Rating: 'up' } : null }),
    });
    await actions.loadSession('s');
    if (hasFeedback)
      await vi.waitFor(() =>
        expect(
          useMessageStore.getState().messages.find((m) => m.id === 'a')
            ?.feedback?.rating,
        ).toBe('up'),
      );
    await actions.loadOlderSessionMessages('s');
    const tools = useMessageStore
      .getState()
      .messages.flatMap((m) => Object.values(m.tools || {}));
    expect(
      tools.some((t) => t.callId === 'lookup-1' && t.output === '42'),
    ).toBe(true);
    if (hasFeedback)
      expect(
        useMessageStore.getState().messages.find((m) => m.responseId === 'resp')
          ?.feedback?.rating,
      ).toBe('up');
  },
);
