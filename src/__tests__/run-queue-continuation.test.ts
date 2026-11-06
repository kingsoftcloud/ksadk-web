import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRunAgent } from '../hooks/useRunAgent.js';
import { RunEngineImpl } from '../core/run/engine.js';
import { ConversationController, type ConversationId } from '../core/conversation/studio-controller.js';
import { useStreamingStore } from '../stores/streaming.js';
import { useSessionStore } from '../stores/session.js';
import { useMessageStore } from '../stores/message.js';
import { useUIStore } from '../stores/ui.js';
import type { ApiFacade } from '../core/api/types.js';
import type { RunEngineConfig } from '../core/run/types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function outputStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  return {
    stream,
    close() {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"status":"completed"}}\n\ndata: [DONE]\n\n'));
      controller.close();
    },
    fail(error: Error) { controller.error(error); },
  };
}

const config: RunEngineConfig = {
  agentId: 'agent-a', apiFormats: ['responses'], agentFramework: 'hermes',
  selectedModel: 'model-a', thinkingMode: 'auto', permissionMode: 'ask',
};

function probe(api: Partial<ApiFacade>) {
  const controller = new ConversationController('fixture-queue-continuation');
  const conversationIdRef = { current: controller.createDraft('agent-a') as string | undefined };
  const currentSessionIdRef = { current: null as string | null };
  const agentIdRef = { current: 'agent-a' };
  const onSettled = vi.fn();
  let actions!: ReturnType<typeof useRunAgent>;
  function Probe() {
    actions = useRunAgent({ ...config, api: api as ApiFacade, uiCapabilities: {}, isMobile: false,
      currentSessionId: currentSessionIdRef.current, currentSessionIdRef, agentIdRef,
      conversationIdRef, queuedDraftRef: { current: [] }, conversationClient: null,
      outbox: controller.outbox,
      onRunSettled: onSettled,
      onSessionCreated: (id, owner) => {
        controller.bindNative(owner as ConversationId, id);
        if (conversationIdRef.current === owner) {
          currentSessionIdRef.current = id;
          useSessionStore.getState().setCurrentSessionId(id);
        }
      },
    });
    return null;
  }
  renderToString(createElement(Probe));
  return { actions, controller, conversationIdRef, currentSessionIdRef, onSettled };
}

function queuedTexts() {
  return useUIStore.getState().queuedDrafts.map(item => item.text);
}

beforeEach(() => {
  useStreamingStore.getState().resetRun();
  useSessionStore.getState().setCurrentSessionId(null);
  useMessageStore.getState().setMessages([]);
  useUIStore.getState().setQueuedDrafts([]);
  useUIStore.setState({ toasts: [] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('run owner queue continuation', () => {
  it('drains the queue after the user stops the run', async () => {
    const first = outputStream();
    const second = outputStream();
    const runAgent = vi.fn().mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);
    const p = probe({
      createSession: vi.fn().mockResolvedValue({ SessionId: 'native-a' }),
      runAgent,
      cancelRun: vi.fn().mockResolvedValue({}),
    });

    await p.actions.submitDraft('first turn', []);
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));
    // Let the engine take the first stream so its run is genuinely abortable.
    await vi.waitFor(() => expect(first.stream.locked).toBe(true));
    await p.actions.submitDraft('queued after stop', []);
    expect(queuedTexts()).toEqual(['queued after stop']);

    p.actions.stopGeneration();
    first.fail(new DOMException('The operation was aborted.', 'AbortError'));

    await vi.waitFor(() => expect(p.onSettled).toHaveBeenCalledWith('native-a', 'agent-a', 'cancelled'));
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(runAgent.mock.calls[1][0])).toContain('queued after stop');
    expect(queuedTexts()).toEqual([]);

    second.close();
    await vi.waitFor(() => expect(p.onSettled).toHaveBeenCalledWith('native-a', 'agent-a', 'completed'));
  });

  it('retries the queue with backoff after a failed run', async () => {
    vi.useFakeTimers();
    const firstRun = deferred<ReadableStream<Uint8Array>>();
    const retried = outputStream();
    const runAgent = vi.fn().mockReturnValueOnce(firstRun.promise).mockResolvedValueOnce(retried.stream);
    const p = probe({
      createSession: vi.fn().mockResolvedValue({ SessionId: 'native-a' }),
      runAgent,
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    await p.actions.submitDraft('first turn', []);
    await p.actions.submitDraft('queued after failure', []);
    expect(queuedTexts()).toEqual(['queued after failure']);

    firstRun.reject(new Error('runtime exploded'));
    await vi.advanceTimersByTimeAsync(0);
    expect(p.onSettled).toHaveBeenCalledWith('native-a', 'agent-a', 'failed');
    expect(runAgent).toHaveBeenCalledTimes(1);

    // Backoff keeps the queue waiting instead of dropping or spinning.
    await vi.advanceTimersByTimeAsync(299);
    expect(runAgent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(runAgent.mock.calls[1][0])).toContain('queued after failure');

    retried.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.onSettled).toHaveBeenCalledWith('native-a', 'agent-a', 'completed');
    expect(errorLog).toHaveBeenCalled();
  });

  it('continues the queue after a disconnect instead of stranding it', async () => {
    const first = outputStream();
    const second = outputStream();
    const runAgent = vi.fn().mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);
    const p = probe({
      createSession: vi.fn().mockResolvedValue({ SessionId: 'native-a' }),
      runAgent,
    });

    await p.actions.submitDraft('first turn', []);
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));
    // Let the engine take the first stream so its run is genuinely abortable.
    await vi.waitFor(() => expect(first.stream.locked).toBe(true));
    await p.actions.submitDraft('queued across disconnect', []);
    expect(queuedTexts()).toEqual(['queued across disconnect']);

    p.actions.disconnectRun();

    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(runAgent.mock.calls[1][0])).toContain('queued across disconnect');
    expect(queuedTexts()).toEqual([]);
    expect(useStreamingStore.getState().isSessionStreaming('native-a')).toBe(true);

    second.close();
    await vi.waitFor(() => expect(p.onSettled).toHaveBeenCalledWith('native-a', 'agent-a', 'completed'));
    first.close();
  });

  it('cancels queued drafts with a visible toast when the session is deleted', async () => {
    const first = outputStream();
    const runAgent = vi.fn().mockResolvedValue(first.stream);
    const p = probe({
      createSession: vi.fn().mockResolvedValue({ SessionId: 'native-a' }),
      runAgent,
    });

    await p.actions.submitDraft('first turn', []);
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));
    // Let the engine take the first stream so its run is genuinely abortable.
    await vi.waitFor(() => expect(first.stream.locked).toBe(true));
    await p.actions.submitDraft('queued before delete', []);
    const owner = p.conversationIdRef.current as ConversationId;
    const dropped = p.controller.outbox.list(owner)
      .find(entry => entry.text === 'queued before delete')!;

    p.actions.disconnectRun('delete');

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(queuedTexts()).toEqual([]);
    const toast = useUIStore.getState().toasts.at(-1);
    expect(toast?.variant).toBe('error');
    expect(toast?.message).toContain('会话已删除');
    expect(toast?.message).toContain('1 条待发消息已取消');
    expect(p.controller.outbox.get(dropped.requestId)?.status).toBe('cancelled');
    first.close();
  });

  it('retries two rejected launches before finally starting the queued turn', async () => {
    vi.useFakeTimers();
    const stream = outputStream();
    const runAgent = vi.fn().mockResolvedValue(stream.stream);
    const p = probe({
      createSession: vi.fn().mockResolvedValue({ SessionId: 'native-a' }),
      runAgent,
    });
    const start = vi.spyOn(RunEngineImpl.prototype, 'start')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false);

    try {
      await p.actions.submitDraft('queued through a refused launch', []);
      expect(runAgent).not.toHaveBeenCalled();
      expect(queuedTexts()).toEqual(['queued through a refused launch']);

      await vi.advanceTimersByTimeAsync(300);
      expect(runAgent).not.toHaveBeenCalled();
      expect(queuedTexts()).toEqual(['queued through a refused launch']);

      await vi.advanceTimersByTimeAsync(600);
      expect(runAgent).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(runAgent.mock.calls[0][0])).toContain('queued through a refused launch');
      expect(queuedTexts()).toEqual([]);

      stream.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(p.onSettled).toHaveBeenCalledWith('native-a', 'agent-a', 'completed');
    } finally {
      start.mockRestore();
    }
  });

  it('keeps an awaiting-input run from starting the next queued turn', async () => {
    const firstRun = deferred<ReadableStream<Uint8Array>>();
    const runAgent = vi.fn().mockReturnValueOnce(firstRun.promise);
    const p = probe({
      createSession: vi.fn().mockResolvedValue({ SessionId: 'native-a' }),
      runAgent,
    });

    await p.actions.submitDraft('needs approval', []);
    await p.actions.submitDraft('queued behind approval', []);
    firstRun.resolve(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'event: response.output_item.done\ndata: {"item":{"id":"approval-queue","type":"mcp_approval_request","name":"write_file","arguments":"{}"}}\n\n'
        + 'event: response.incomplete\ndata: {"type":"response.incomplete"}\n\n',
      ));
      controller.close();
    } }));

    await vi.waitFor(() => expect(p.onSettled).toHaveBeenCalledWith('native-a', 'agent-a', 'awaiting-input'));
    // The pending approval owns the idle engine; draining now would make its
    // answer path reject, so the queue waits for that interaction round.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(queuedTexts()).toEqual(['queued behind approval']);
  });
});
