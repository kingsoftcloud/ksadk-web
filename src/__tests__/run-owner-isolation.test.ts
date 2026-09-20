import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRunAgent } from '../hooks/useRunAgent.js';
import { RunEngineImpl } from '../core/run/engine.js';
import { dispatchRunEventToStores } from '../core/run/dispatcher.js';
import { ConversationController, type ConversationId } from '../core/conversation/studio-controller.js';
import { sharedInteractionStore } from '../core/interaction/index.js';
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
    delta(text: string) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`)); },
    close() {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"status":"completed"}}\n\ndata: [DONE]\n\n'));
      controller.close();
    },
  };
}

const config: RunEngineConfig = {
  agentId: 'agent-a', apiFormats: ['responses'], agentFramework: 'hermes',
  selectedModel: 'model-a', thinkingMode: 'auto', permissionMode: 'ask',
};

function probe(api: Partial<ApiFacade>) {
  const controller = new ConversationController('fixture-run-owners');
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
  function newDraft() {
    conversationIdRef.current = controller.createDraft('agent-a');
    currentSessionIdRef.current = null;
    useSessionStore.getState().setCurrentSessionId(null);
    useMessageStore.getState().setMessages([]);
    useUIStore.getState().setQueuedDrafts([]);
    return conversationIdRef.current;
  }
  return { actions, controller, conversationIdRef, currentSessionIdRef, newDraft, onSettled };
}

beforeEach(() => {
  useStreamingStore.getState().resetRun();
  useSessionStore.getState().setCurrentSessionId(null);
  useMessageStore.getState().setMessages([]);
  useUIStore.getState().setQueuedDrafts([]);
  sharedInteractionStore.clearSession('native-a');
  sharedInteractionStore.clearSession('native-b');
});

describe('submitted conversation ownership', () => {
  it.each([true, false])('settles an approval wait without a retryable failure (approval=%s)', async approval => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(
        (approval ? 'event: response.output_item.done\ndata: {"item":{"id":"approval-legacy","type":"mcp_approval_request","name":"lookup","arguments":"{}"}}\n\n' : '')
        + 'event: response.incomplete\ndata: {"type":"response.incomplete"}\n\n',
      ));
      controller.close();
    } });
    const p = probe({ createSession: vi.fn().mockResolvedValue({ SessionId: 'native-a' }),
      runAgent: vi.fn().mockResolvedValue(stream) });
    const owner = p.conversationIdRef.current as ConversationId;
    await p.actions.submitDraft('one approved operation', []);
    await vi.waitFor(() => expect(p.onSettled).toHaveBeenCalledWith(
      'native-a', 'agent-a', approval ? 'awaiting-input' : 'failed',
    ));
    expect(p.controller.outbox.list(owner).map(entry => entry.status)).toEqual(
      [approval ? 'completed' : 'failed'],
    );
    if (approval) expect(sharedInteractionStore.get('native-a', 'approval-legacy')?.status).toBe('pending');
  });

  it('keeps two pre-native drafts independent when CreateSession returns in reverse order', async () => {
    const a = deferred<{ SessionId: string }>();
    const b = deferred<{ SessionId: string }>();
    const streams = [outputStream(), outputStream()];
    const createSession = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const runAgent = vi.fn().mockResolvedValueOnce(streams[0].stream).mockResolvedValueOnce(streams[1].stream);
    const p = probe({ createSession, runAgent });
    const ownerA = p.conversationIdRef.current as ConversationId;
    await p.actions.submitDraft('draft A', []);
    const ownerB = p.newDraft() as ConversationId;
    await p.actions.submitDraft('draft B', []);
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(useStreamingStore.getState().isSessionStreaming(ownerA)).toBe(true);
    expect(useStreamingStore.getState().isSessionStreaming(ownerB)).toBe(true);

    b.resolve({ SessionId: 'native-b' });
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));
    const runB = useStreamingStore.getState().currentRunId;
    a.resolve({ SessionId: 'native-a' });
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));
    expect(p.controller.binding(ownerA)?.nativeSessionId).toBe('native-a');
    expect(p.controller.binding(ownerB)?.nativeSessionId).toBe('native-b');
    expect(p.currentSessionIdRef.current).toBe('native-b');
    expect(useStreamingStore.getState().currentRunId).toBe(runB);
    expect(runAgent.mock.calls.map(([body]) => body.SessionId)).toEqual(['native-b', 'native-a']);

    streams[1].delta('offscreen A');
    streams[1].close();
    await vi.waitFor(() => expect(p.onSettled).toHaveBeenCalledWith('native-a', 'agent-a', 'completed'));
    expect(useMessageStore.getState().messages.some(item => item.content.includes('offscreen A'))).toBe(false);
    expect(useStreamingStore.getState().isSessionStreaming('native-b')).toBe(true);
    streams[0].close();
    await vi.waitFor(() => expect(p.onSettled).toHaveBeenCalledWith('native-b', 'agent-a', 'completed'));
    expect(p.controller.outbox.list(ownerA).map(entry => entry.status)).toEqual(['completed']);
  });

  it('drains a queued message into its original session while another draft is selected', async () => {
    const streams = [outputStream(), outputStream(), outputStream()];
    const runAgent = vi.fn().mockResolvedValueOnce(streams[0].stream)
      .mockResolvedValueOnce(streams[1].stream).mockResolvedValueOnce(streams[2].stream);
    const p = probe({ createSession: vi.fn().mockResolvedValueOnce({ SessionId: 'native-a' }).mockResolvedValueOnce({ SessionId: 'native-b' }), runAgent });
    await p.actions.submitDraft('A first', []);
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));
    await p.actions.submitDraft('A queued', []);
    expect(useUIStore.getState().queuedDrafts.map(item => item.text)).toEqual(['A queued']);
    p.newDraft();
    await p.actions.submitDraft('B first', []);
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));
    streams[0].close();
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(3));
    expect(runAgent.mock.calls[2][0]).toMatchObject({ AgentId: 'agent-a', SessionId: 'native-a' });
    expect(JSON.stringify(runAgent.mock.calls[2][0])).toContain('A queued');
    expect(p.currentSessionIdRef.current).toBe('native-b');
    expect(useUIStore.getState().queuedDrafts).toEqual([]);
    expect(useMessageStore.getState().messages.filter(item => item.role === 'user').map(item => item.content)).toEqual(['B first']);
    streams[1].close(); streams[2].close();
    await vi.waitFor(() => expect(p.onSettled).toHaveBeenCalledTimes(3));
  });

  it('never executes a fabricated session after creation fails', async () => {
    const runAgent = vi.fn();
    const p = probe({ createSession: vi.fn().mockRejectedValue(new Error('creation uncertain')), runAgent });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await p.actions.submitDraft('preserve this failed submission', []);
      await vi.waitFor(() => expect(p.onSettled).toHaveBeenCalledTimes(1));
      expect(runAgent).not.toHaveBeenCalled();
      expect(p.currentSessionIdRef.current).toBeNull();
      expect(useMessageStore.getState().messages.map(item => item.content).join('\n')).toContain('creation uncertain');
      expect(useStreamingStore.getState().isSessionStreaming(p.conversationIdRef.current)).toBe(false);
      expect(p.controller.outbox.list(p.conversationIdRef.current as ConversationId).at(-1)?.status).toBe('failed');
    } finally { errorLog.mockRestore(); }
  });

  it('does not enqueue a second copy of a request already owned by the live queue', async () => {
    const stream = outputStream();
    const p = probe({ createSession: vi.fn().mockResolvedValue({ SessionId: 'native-a' }),
      runAgent: vi.fn().mockResolvedValue(stream.stream), cancelRun: vi.fn().mockResolvedValue({}) });
    await p.actions.submitDraft('first', []);
    await p.actions.submitDraft('queued once', []);
    const entry = p.controller.outbox.list().find(item => item.text === 'queued once')!;
    await p.actions.submitDraft(entry.text, [], undefined, undefined, undefined, entry.requestId);
    const queued = useUIStore.getState().queuedDrafts.map(item => item.text);
    p.actions.disconnectRun();
    stream.close();
    expect(queued).toEqual(['queued once']);
  });

  it('keeps a network submission unknown in the outbox and does not drain queued work', async () => {
    const p = probe({ createSession: vi.fn().mockResolvedValue({ SessionId: 'native-a' }),
      runAgent: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await p.actions.submitDraft('network uncertain', []);
      await vi.waitFor(() => expect(p.onSettled).toHaveBeenCalledWith('native-a', 'agent-a', 'unknown'));
      expect(p.controller.outbox.list(p.conversationIdRef.current as ConversationId).at(-1)?.status).toBe('unknown');
      expect(p.controller.outbox.list(p.conversationIdRef.current as ConversationId)).toHaveLength(1);
    } finally { errorLog.mockRestore(); }
  });

  it('freezes active Agent/model configuration and cancels using each engine’s own invocation', async () => {
    const created = deferred<{ SessionId: string }>();
    const a = outputStream(); const b = outputStream();
    const calls: Record<string, unknown>[] = [];
    const cancelRun = vi.fn().mockResolvedValue({});
    const first = new RunEngineImpl({ createSession: () => created.promise, cancelRun,
      runAgent: async (body: Record<string, unknown>) => { calls.push(body); return a.stream; },
    } as unknown as ApiFacade, { isVisible: () => false });
    const second = new RunEngineImpl({ cancelRun,
      runAgent: async (body: Record<string, unknown>) => { calls.push(body); return b.stream; },
    } as unknown as ApiFacade);
    first.updateConfig(config);
    second.updateConfig({ ...config, agentId: 'agent-b', selectedModel: 'model-b' });
    const done = vi.fn();
    first.start({ text: 'A', attachments: [], onSettled: done });
    first.updateConfig({ ...config, agentId: 'next-agent', selectedModel: 'next-model' });
    second.start({ text: 'B', attachments: [], sessionId: 'native-b', onSettled: done });
    created.resolve({ SessionId: 'native-a' });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    const callA = calls.find(call => call.SessionId === 'native-a')!;
    const callB = calls.find(call => call.SessionId === 'native-b')!;
    expect(callA.AgentId).toBe('agent-a');
    expect(JSON.stringify(callA)).toContain('model-a');
    useStreamingStore.getState().setSessionStreaming('native-a', true);
    useStreamingStore.getState().setSessionStreaming('native-b', true);
    const visibleActivity = useStreamingStore.getState().activity;
    first.stop();
    expect(useStreamingStore.getState().activity).toBe(visibleActivity);
    expect(useStreamingStore.getState().isSessionStreaming('native-b')).toBe(true);
    expect(useStreamingStore.getState().isStreaming).toBe(true);
    second.stop();
    expect(cancelRun.mock.calls).toEqual([
      ['agent-a', 'native-a', callA.InvocationId], ['agent-b', 'native-b', callB.InvocationId],
    ]);
    a.close(); b.close();
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(2));
  });

  it('resumes kernel subscriptions from each engine’s own cursor', async () => {
    vi.useFakeTimers();
    const wire = (value: string) => new Response(value).body!;
    const calls: Array<[string, number]> = [];
    const api = {
      runAgent: async () => wire(JSON.stringify({ Data: { ReceiptStatus: 'accepted' } })),
      subscribeSessionEvents: async (sessionId: string, afterSeq: number) => {
        calls.push([sessionId, afterSeq]);
        const seq = sessionId === 'native-a' ? 11 : 90;
        const event = { seq: afterSeq ? seq + 1 : seq, family: 'runtime',
          event_type: afterSeq ? 'run.completed' : 'run.started', run_id: `run-${sessionId}` };
        return wire(`data: ${JSON.stringify(event)}\n\n`);
      },
    } as unknown as ApiFacade;
    const first = new RunEngineImpl(api);
    const second = new RunEngineImpl(api);
    first.updateConfig(config); second.updateConfig(config);
    const settled = vi.fn();
    try {
      first.start({ text: 'A', attachments: [], sessionId: 'native-a', onSettled: settled });
      second.start({ text: 'B', attachments: [], sessionId: 'native-b', onSettled: settled });
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toEqual([['native-a', 0], ['native-b', 0]]);
      useStreamingStore.getState().setLastSeqId(777);
      await vi.advanceTimersByTimeAsync(3001);
      expect(calls.slice(2)).toEqual([['native-a', 11], ['native-b', 90]]);
      expect(settled).toHaveBeenCalledTimes(2);
    } finally { first.disconnect(); second.disconnect(); vi.useRealTimers(); }
  });

  it('retains offscreen approvals without changing the visible transcript', () => {
    useSessionStore.getState().setCurrentSessionId('native-b');
    useMessageStore.getState().setMessages([{ id: 'b', role: 'user', content: 'B', timestamp: 1 }]);
    dispatchRunEventToStores({ type: 'approval_requested', sessionId: 'native-a', messageId: 'a',
      approvalRequestId: 'approval-a', protocol: 'responses', name: 'write_file', args: '{}',
    }, { visible: false });
    expect(sharedInteractionStore.listPending('native-a')).toHaveLength(1);
    expect(useMessageStore.getState().messages.map(item => item.id)).toEqual(['b']);
  });
});
