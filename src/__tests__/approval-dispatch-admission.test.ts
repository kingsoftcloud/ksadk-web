import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.js';
import { InteractionClientImpl } from '../core/interaction/client.js';
import { RunEngineImpl } from '../core/run/engine.js';
import type { Interaction } from '../core/interaction/types.js';
import { useFeedback } from '../hooks/useFeedback.js';
import { useRunAgent } from '../hooks/useRunAgent.js';
import { useMessageStore } from '../stores/message.js';
import { useSessionStore } from '../stores/session.js';
import { useStreamingStore } from '../stores/streaming.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function approvalClient(runAgent: ReturnType<typeof vi.fn>) {
  let feedback!: ReturnType<typeof useFeedback>;
  function Probe() {
    const actions = useRunAgent({
      agentId: 'agent-a', currentSessionId: 'session-a', agentFramework: 'hermes',
      apiFormats: ['responses'], selectedModel: 'model', thinkingMode: 'auto',
      permissionMode: 'ask', uiCapabilities: {}, isMobile: false,
      api: { runAgent } as never, currentSessionIdRef: { current: 'session-a' },
      agentIdRef: { current: 'agent-a' }, queuedDraftRef: { current: [] },
      conversationClient: null,
    });
    feedback = useFeedback({
      agentId: 'agent-a', currentSessionId: 'session-a', isStreaming: false,
      api: {} as never, submitDraft: actions.submitDraft,
    });
    return null;
  }
  renderToString(createElement(Probe));
  const client = new InteractionClientImpl({
    agentId: 'agent-a', submitInteraction: vi.fn(),
    legacyResponsesApproval: (id, approve) => feedback.respondToApproval({ approvalRequestId: id, approve }),
  });
  client.ingest({
    version: 1, interactionId: 'approval-a', sessionId: 'session-a', kind: 'approval',
    title: 'Approve', source: 'responses', status: 'pending', revision: 1,
    createdAt: '2026-10-13T00:00:00Z', extensions: {},
  } as Interaction);
  return client;
}

beforeEach(() => {
  useStreamingStore.getState().resetRun();
  useSessionStore.getState().setCurrentSessionId('session-a');
  useMessageStore.getState().setMessages([{
    id: 'message-a', role: 'model', content: '', timestamp: 1,
    tools: { shell: { name: 'shell', args: '{}', status: 'paused',
      approvalRequestId: 'approval-a', approvalStatus: 'pending' } },
  }]);
});

describe('legacy approval transport admission', () => {
  it('does not confirm a kernel receipt that arrives after disconnect', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const subscribeSessionEvents = vi.fn();
    const engine = new RunEngineImpl({
      runAgent: vi.fn().mockResolvedValue(body), subscribeSessionEvents,
    } as never);
    engine.updateConfig({ agentId: 'agent-a', agentFramework: 'hermes',
      apiFormats: ['responses'], selectedModel: 'model', thinkingMode: 'auto',
      kernelSessionEventsEnabled: true });
    const admitted = vi.fn();
    engine.start({ text: '', attachments: [], sessionId: 'session-a',
      responsesInput: [{ type: 'mcp_approval_response', approval_request_id: 'approval-a', approve: true }],
      onDispatchResult: admitted });
    await vi.waitFor(() => expect(engine.stage).toBe('streaming'));
    expect(admitted).not.toHaveBeenCalled();
    engine.disconnect();
    controller.enqueue(new TextEncoder().encode(JSON.stringify({
      Code: 0, Data: { ReceiptStatus: 'accepted', CommandId: 'command-a' },
    })));
    controller.close();
    await vi.waitFor(() => expect(admitted).toHaveBeenCalledWith(false));
    expect(admitted).toHaveBeenCalledOnce();
    expect(subscribeSessionEvents).not.toHaveBeenCalled();
    expect(engine.stage).toBe('idle');
  });

  it.each(['rejected', 'unsupported', 'queue_full'] as const)(
    'does not confirm an HTTP 200 kernel %s receipt', async status => {
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({
          Code: 0, Data: { ReceiptStatus: status, CommandId: 'command-a',
            Error: { code: status, message: 'Not accepted', retryable: true } },
        })));
        controller.close();
      } });
      const engine = new RunEngineImpl({ runAgent: vi.fn().mockResolvedValue(stream) } as never);
      engine.updateConfig({ agentId: 'agent-a', agentFramework: 'hermes',
        apiFormats: ['responses'], selectedModel: 'model', thinkingMode: 'auto',
        kernelSessionEventsEnabled: true });
      const admitted = vi.fn();
      engine.start({ text: '', attachments: [], sessionId: 'session-a',
        responsesInput: [{ type: 'mcp_approval_response', approval_request_id: 'approval-a', approve: true }],
        onDispatchResult: admitted });
      await vi.waitFor(() => expect(admitted).toHaveBeenCalledWith(false));
      expect(admitted).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(engine.stage).toBe('idle'));
    },
  );

  it('does not confirm a delayed HTTP response after disconnect', async () => {
    const request = deferred<ReadableStream<Uint8Array>>();
    const runAgent = vi.fn().mockReturnValue(request.promise);
    const engine = new RunEngineImpl({ runAgent } as never);
    engine.updateConfig({ agentId: 'agent-a', agentFramework: 'hermes',
      apiFormats: ['responses'], selectedModel: 'model', thinkingMode: 'auto' });
    const admitted = vi.fn();
    expect(engine.start({ text: '', attachments: [], sessionId: 'session-a',
      responsesInput: [{ type: 'mcp_approval_response', approval_request_id: 'approval-a', approve: true }],
      onDispatchResult: admitted })).toBe(true);
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledOnce());
    engine.disconnect();
    const cancelled = vi.fn();
    request.resolve(new ReadableStream<Uint8Array>({ cancel: cancelled }));
    await vi.waitFor(() => expect(admitted).toHaveBeenCalledWith(false));
    expect(admitted).toHaveBeenCalledOnce();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(engine.stage).toBe('idle');
  });

  it.each(['approve', 'reject'] as const)('keeps %s retryable after an HTTP failure', async action => {
    const request = deferred<ReadableStream<Uint8Array>>();
    const runAgent = vi.fn().mockReturnValueOnce(request.promise);
    const client = approvalClient(runAgent);
    const input = { interactionId: 'approval-a', expectedRevision: 1, action,
      response: { approved: action === 'approve' }, idempotencyKey: 'approval-key' };
    const first = client.respond(input);
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledOnce());
    expect(client.store.get('session-a', 'approval-a')?.status).toBe('resolving');
    expect(useMessageStore.getState().messages[0].tools?.shell.approvalStatus).toBe('pending');
    request.reject(new ApiError(503, 'Service unavailable'));
    expect((await first).status).toBe('rejected');
    expect(client.store.get('session-a', 'approval-a')?.status).toBe('failed');
    expect(useMessageStore.getState().messages[0].tools?.shell.approvalStatus).toBe('pending');

    let controller!: ReadableStreamDefaultController<Uint8Array>;
    runAgent.mockResolvedValueOnce(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }));
    const retry = client.respond(input);
    // Admission must settle before the output stream closes (which may take minutes).
    await vi.waitFor(() => expect(client.store.get('session-a', 'approval-a')?.status).toBe('resolved'));
    expect((await retry).status).toBe('accepted');
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(useMessageStore.getState().messages[0].tools?.shell.approvalStatus)
      .toBe(action === 'approve' ? 'approved' : 'rejected');
    controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"status":"completed"}}\n\ndata: [DONE]\n\n'));
    controller.close();
    await vi.waitFor(() => expect(useStreamingStore.getState().isSessionStreaming('session-a')).toBe(false));
  });
});
