import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunEngineImpl } from '../core/run/engine.js';
import type { ApiFacade } from '../core/api/types.js';
import { useStreamingStore } from '../stores/streaming.js';
import { useMessageStore } from '../stores/message.js';
import { useSessionStore } from '../stores/session.js';
import { useCheckpointStore } from '../stores/checkpoint.js';
import { dispatchRunEventToStores, resetDispatcherState } from '../core/run/dispatcher.js';

function createApiFacade(calls: Record<string, unknown>[]): ApiFacade {
  return {
    async listSessions() { return []; },
    async createSession() { return { SessionId: 'session-1' }; },
    async deleteSession() {},
    async listSessionEvents() { return { Events: [] }; },
    async listSessionCheckpoints() { return { Checkpoints: [] }; },
    async listToolReceipts() { return { ToolReceipts: [] }; },
    async previewCheckpointResume(params) {
      calls.push({ preview: params });
      return { Preview: { Risk: { Level: 'medium', DuplicateSideEffectRisk: true } } };
    },
    async runAgent(body) {
      calls.push(body);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
    },
    async resumeRun(params) {
      calls.push(params);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: response.completed\ndata: {"status":"completed","output_text":"resumed"}\n\n'));
          controller.close();
        },
      });
    },
    async subscribeRunEvents() {
      return new ReadableStream<Uint8Array>();
    },
    async cancelRun(agentId, invocationId) {
      calls.push({ cancel: { agentId, invocationId } });
      return { Cancelled: true, Found: true, Status: 'cancelling' };
    },
    async getResponseFeedback() { return null; },
    async upsertResponseFeedback() { return null; },
    async deleteResponseFeedback() {},
    async listWorkspaceFiles() { return {}; },
    async addWorkspaceFile() { return {}; },
    async deleteWorkspaceFile() {},
    async getWorkspaceFileContent() { return ''; },
    async listAgentModels() { return {}; },
    async getAgentUiBootstrap() { return {}; },
    async uploadFile() {
      return { FileData: { fileUri: 'file-1', displayName: 'file.txt', mimeType: 'text/plain' } };
    },
  };
}

const activeEngines = new Set<RunEngineImpl>();

function createRunEngine(api: ApiFacade): RunEngineImpl {
  const engine = new RunEngineImpl(api);
  activeEngines.add(engine);
  return engine;
}

async function waitForCalls(calls: Record<string, unknown>[], count = 1) {
  for (let i = 0; i < 20; i += 1) {
    if (calls.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`expected ${count} runAgent call(s), got ${calls.length}`);
}

async function waitForEngineIdle(engine: RunEngineImpl) {
  for (let i = 0; i < 20 && engine.stage !== 'idle'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('RunEngineImpl', () => {
  afterEach(async () => {
    await Promise.all([...activeEngines].map(waitForEngineIdle));
    activeEngines.clear();
    useStreamingStore.getState().resetRun();
    useMessageStore.getState().setMessages([]);
    useSessionStore.getState().setCurrentSessionId(null);
    useCheckpointStore.getState().clearSessionCheckpoints();
    resetDispatcherState();
  });

  it('uses the latest runtime config when starting a run', async () => {
    const calls: Record<string, unknown>[] = [];
    const engine = createRunEngine(createApiFacade(calls));

    engine.updateConfig({
      agentId: 'agent-live',
      apiFormats: ['responses'],
      agentFramework: 'langgraph',
      selectedModel: 'model-live',
      thinkingMode: 'disabled',
      checkpointResumePreviewEnabled: true,
    });

    engine.start({
      text: 'hello',
      attachments: [],
      sessionId: 'session-live',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls[0]).toMatchObject({
      AgentId: 'agent-live',
      SessionId: 'session-live',
      Model: 'model-live',
      ModelOptions: { thinking: { type: 'disabled' } },
    });
  });

  it('skips checkpoint resume preview when the capability is disabled', async () => {
    const calls: Record<string, unknown>[] = [];
    const engine = createRunEngine(createApiFacade(calls));

    engine.updateConfig({
      agentId: 'agent-live',
      apiFormats: ['responses'],
      agentFramework: 'langgraph',
      selectedModel: 'model-live',
      thinkingMode: 'disabled',
      checkpointResumePreviewEnabled: false,
    });

    const accepted = engine.resumeCheckpoint({
      sessionId: 'session-live',
      runId: 'run-1',
      checkpointId: 'ckpt-1',
    });

    expect(accepted).toBe(true);
    await waitForCalls(calls);
    await waitForEngineIdle(engine);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      agentId: 'agent-live',
      sessionId: 'session-live',
      runId: 'run-1',
      checkpointId: 'ckpt-1',
      invocationId: expect.stringMatching(/^run_/),
    });
  });

  it('sends ordinary hosted chat runs as Responses input while keeping legacy Messages', async () => {
    const calls: Record<string, unknown>[] = [];
    const engine = createRunEngine(createApiFacade(calls));

    engine.updateConfig({
      agentId: 'agent-live',
      apiFormats: ['responses', 'chat_completions'],
      agentFramework: 'langgraph',
      selectedModel: '',
      thinkingMode: 'auto',
    });

    engine.start({
      text: 'hello responses',
      attachments: [],
      sessionId: 'session-live',
    });

    await waitForCalls(calls);

    const expectedContent = [{ type: 'input_text', text: 'hello responses' }];
    expect(calls[0]).toMatchObject({
      ApiFormat: 'responses',
      ResponsesInput: [{ role: 'user', content: expectedContent }],
      Messages: [{ role: 'user', content: expectedContent }],
    });
  });

  it('sends uploaded attachments as Responses input_file references', async () => {
    const calls: Record<string, unknown>[] = [];
    const engine = createRunEngine(createApiFacade(calls));

    engine.updateConfig({
      agentId: 'agent-live',
      apiFormats: ['responses'],
      agentFramework: 'langgraph',
      selectedModel: '',
      thinkingMode: 'auto',
    });

    engine.start({
      text: 'read this',
      attachments: [new File(['hello'], 'local.txt', { type: 'text/plain' })],
      sessionId: 'session-live',
    });

    await waitForCalls(calls);

    const expectedContent = [
      { type: 'input_text', text: 'read this' },
      { type: 'input_file', filename: 'file.txt', file_url: 'file-1' },
    ];
    expect(calls[0]).toMatchObject({
      ApiFormat: 'responses',
      ResponsesInput: [{ role: 'user', content: expectedContent }],
      Messages: [{ role: 'user', content: expectedContent }],
    });
  });

  it('sends image attachments as Responses input_image data URLs', async () => {
    const calls: Record<string, unknown>[] = [];
    const engine = createRunEngine(createApiFacade(calls));

    engine.updateConfig({
      agentId: 'agent-live',
      apiFormats: ['responses'],
      agentFramework: 'langgraph',
      selectedModel: '',
      thinkingMode: 'auto',
    });

    const image = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'sample.png', {
      type: 'image/png',
    });
    const imageBase64 = Buffer.from(await image.arrayBuffer()).toString('base64');

    engine.start({
      text: 'look at this',
      attachments: [image],
      sessionId: 'session-live',
    });

    await waitForCalls(calls);

    const expectedContent = [
      { type: 'input_text', text: 'look at this' },
      { type: 'input_image', image_url: `data:image/png;base64,${imageBase64}` },
    ];
    expect(calls[0]).toMatchObject({
      ApiFormat: 'responses',
      ResponsesInput: [{ role: 'user', content: expectedContent }],
      Messages: [{ role: 'user', content: expectedContent }],
    });
  });

  it('does not warn when uploading attachments for an existing session', async () => {
    const calls: Record<string, unknown>[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const engine = createRunEngine(createApiFacade(calls));

    engine.updateConfig({
      agentId: 'agent-live',
      apiFormats: ['responses'],
      agentFramework: 'langgraph',
      selectedModel: '',
      thinkingMode: 'auto',
    });

    engine.start({
      text: 'look at this',
      attachments: [new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'sample.png', { type: 'image/png' })],
      sessionId: 'session-live',
    });

    await waitForCalls(calls);

    expect(warnSpy).not.toHaveBeenCalledWith('[RunEngine] Invalid transition: idle → uploading-files');
    warnSpy.mockRestore();
  });

  it('resumes from a checkpoint through the dedicated ResumeRun action', async () => {
    const calls: Record<string, unknown>[] = [];
    const engine = createRunEngine(createApiFacade(calls));
    const activities: string[] = [];
    engine.subscribe((event) => {
      if (event.type === 'activity') {
        activities.push(event.phase);
      }
    });

    engine.updateConfig({
      agentId: 'agent-live',
      apiFormats: ['responses'],
      agentFramework: 'langgraph',
      selectedModel: 'model-live',
      thinkingMode: 'disabled',
      checkpointResumePreviewEnabled: true,
    });

    const accepted = engine.resumeCheckpoint({
      sessionId: 'session-live',
      runId: 'run-1',
      checkpointId: 'ckpt-1',
    });

    expect(accepted).toBe(true);
    await waitForCalls(calls);
    await waitForEngineIdle(engine);

    expect(calls[0]).toEqual({
      preview: {
        agentId: 'agent-live',
        sessionId: 'session-live',
        runId: 'run-1',
        checkpointId: 'ckpt-1',
      },
    });
    expect(calls[1]).toEqual({
      agentId: 'agent-live',
      sessionId: 'session-live',
      runId: 'run-1',
      checkpointId: 'ckpt-1',
      invocationId: expect.stringMatching(/^run_/),
    });
    expect(activities).toContain('恢复预览完成：medium 风险');
    expect(activities).toContain('从 checkpoint 恢复运行');
  });

  it('sets a cancellable invocation id while resuming from a checkpoint', async () => {
    const calls: Record<string, unknown>[] = [];
    const engine = createRunEngine(createApiFacade(calls));

    engine.updateConfig({
      agentId: 'agent-live',
      apiFormats: ['responses'],
      agentFramework: 'langgraph',
      selectedModel: 'model-live',
      thinkingMode: 'disabled',
    });

    const accepted = engine.resumeCheckpoint({
      sessionId: 'session-live',
      runId: 'run-1',
      checkpointId: 'ckpt-1',
    });

    expect(accepted).toBe(true);
    await waitForCalls(calls);
    const resumeCall = calls.find((call) => 'checkpointId' in call && 'invocationId' in call);
    const invocationId = String(resumeCall?.invocationId || '');
    expect(invocationId).toMatch(/^run_/);
    expect(useStreamingStore.getState().currentRunId).toBe(invocationId);

    await engine.cancelRemote(invocationId);
    expect(calls.at(-1)).toEqual({
      cancel: { agentId: 'agent-live', invocationId },
    });
  });

  it('creates a session and continues to run the first image message', async () => {
    const calls: Record<string, unknown>[] = [];
    const engine = createRunEngine(createApiFacade(calls));

    engine.updateConfig({
      agentId: 'agent-live',
      apiFormats: ['responses'],
      agentFramework: 'langgraph',
      selectedModel: '',
      thinkingMode: 'auto',
    });

    const image = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'first.png', {
      type: 'image/png',
    });
    const imageBase64 = Buffer.from(await image.arrayBuffer()).toString('base64');
    const createdSessions: string[] = [];

    engine.start({
      text: 'first image turn',
      attachments: [image],
      sessionId: null,
      onSessionCreated: (sessionId) => {
        createdSessions.push(sessionId);
      },
    });

    await waitForCalls(calls);

    expect(createdSessions).toEqual(['session-1']);
    expect(calls[0]).toMatchObject({
      SessionId: 'session-1',
      ApiFormat: 'responses',
      ResponsesInput: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'first image turn' },
            { type: 'input_image', image_url: `data:image/png;base64,${imageBase64}` },
          ],
        },
      ],
    });
  });

  it('updates run activity state when activity events are dispatched', () => {
    dispatchRunEventToStores({
      type: 'activity',
      phase: '等待首个输出',
      status: 'waiting',
      detail: '正在接收流式事件',
      countEvent: false,
    });

    const activity = useStreamingStore.getState().activity;
    expect(activity).toMatchObject({
      phase: '等待首个输出',
      status: 'waiting',
      detail: '正在接收流式事件',
    });
  });

  it('settles running tools when a run reaches a terminal status', () => {
    useSessionStore.getState().setCurrentSessionId('session-live');
    dispatchRunEventToStores({
      type: 'tool_upsert',
      messageId: 'assistant-1',
      name: 'run_code',
      args: '{"code":"print(42)"}',
      status: 'running',
      sessionId: 'session-live',
    });

    dispatchRunEventToStores({
      type: 'terminal',
      status: 'completed',
      sessionId: 'session-live',
    });

    const messages = useMessageStore.getState().messages;
    expect(messages[0].tools?.run_code.status).toBe('completed');
  });

  it('stores checkpoint records delivered by a background run subscription', () => {
    useSessionStore.getState().setCurrentSessionId('session-live');

    dispatchRunEventToStores({
      type: 'stream_event',
      sessionId: 'session-live',
      event: {
        EventId: 'event-ckpt-1',
        SessionId: 'session-live',
        InvocationId: 'longtask_run-1',
        EventType: 'run_checkpoint',
        SeqId: 12,
        Timestamp: '2026-06-10T10:00:00Z',
        Content: {
          status: 'checkpointed',
          run_id: 'run-1',
          checkpoint_id: 'ckpt-1',
          framework: 'langgraph',
        },
        Metadata: {
          run_id: 'run-1',
          checkpoint_id: 'ckpt-1',
          framework: 'langgraph',
          framework_ref: {
            langgraph: {
              thread_id: 'session-live:run-1',
              checkpoint_id: 'ckpt-1',
            },
          },
          stage: '拉取业务数据',
          summary: '第一个业务安全点已保存',
          next_action: '继续清洗聚合指标',
          status: 'completed',
        },
      },
    });

    expect(useCheckpointStore.getState().getSessionCheckpoints('session-live')).toEqual([
      expect.objectContaining({
        checkpointId: 'ckpt-1',
        runId: 'run-1',
        sessionId: 'session-live',
        invocationId: 'longtask_run-1',
        stage: '拉取业务数据',
        nextAction: '继续清洗聚合指标',
      }),
    ]);
  });

  it('marks background run cancellation from subscribed run status without clearing checkpoints', () => {
    useSessionStore.getState().setCurrentSessionId('session-live');
    useStreamingStore.getState().updateActivity({
      sessionId: 'session-live',
      status: 'running',
      phase: '后台长任务运行中',
    });
    useCheckpointStore.getState().upsertSessionCheckpoint('session-live', {
      CheckpointId: 'ckpt-1',
      RunId: 'run-1',
      SessionId: 'session-live',
    });

    dispatchRunEventToStores({
      type: 'stream_event',
      sessionId: 'session-live',
      event: {
        EventId: 'event-status-1',
        SessionId: 'session-live',
        InvocationId: 'longtask_run-1',
        EventType: 'run_status',
        SeqId: 13,
        Timestamp: '2026-06-10T10:00:03Z',
        Content: { status: 'cancelled' },
        Metadata: { status: 'cancelled' },
      },
    });

    expect(useStreamingStore.getState().getSessionActivity('session-live')).toMatchObject({
      status: 'stopped',
      phase: '后台长任务已取消',
    });
    expect(useCheckpointStore.getState().getSessionCheckpoints('session-live')).toHaveLength(1);
  });

  it('reports the settled session id after a run finishes', async () => {
    const calls: Record<string, unknown>[] = [];
    const engine = createRunEngine(createApiFacade(calls));
    const settledSessionIds: Array<string | null> = [];

    engine.updateConfig({
      agentId: 'agent-live',
      apiFormats: ['responses'],
      agentFramework: 'langgraph',
      selectedModel: '',
      thinkingMode: 'auto',
    });

    engine.start({
      text: 'hello',
      attachments: [],
      sessionId: 'session-live',
      onSettled: (sessionId) => {
        settledSessionIds.push(sessionId);
      },
    });

    await waitForCalls(calls);
    for (let i = 0; i < 20 && settledSessionIds.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(settledSessionIds).toEqual(['session-live']);
  });

  it('does not replace an existing session when the runtime returns an empty stream', async () => {
    const calls: Record<string, unknown>[] = [];
    const createdSessions: string[] = [];
    const engine = createRunEngine({
      ...createApiFacade(calls),
      async createSession() {
        createdSessions.push('session-created-after-empty-stream');
        return { SessionId: 'session-created-after-empty-stream' };
      },
      async runAgent(body) {
        calls.push(body);
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
      },
    });
    const settledSessionIds: Array<string | null> = [];

    engine.updateConfig({
      agentId: 'agent-live',
      apiFormats: ['responses'],
      agentFramework: 'hermes',
      selectedModel: '',
      thinkingMode: 'auto',
    });

    engine.start({
      text: 'continue history',
      attachments: [],
      sessionId: 'session-history',
      onSettled: (sessionId) => {
        settledSessionIds.push(sessionId);
      },
    });

    await waitForCalls(calls);
    for (let i = 0; i < 20 && engine.stage !== 'idle'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ SessionId: 'session-history' });
    expect(createdSessions).toEqual([]);
    expect(settledSessionIds).toEqual(['session-history']);
  });

  it('keeps response.failed as failed instead of overwriting it as completed', async () => {
    const calls: Record<string, unknown>[] = [];
    const engine = createRunEngine({
      ...createApiFacade(calls),
      async runAgent(body) {
        calls.push(body);
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              'event: response.failed\n'
              + 'data: {"error":{"message":"image_url is only supported by certain models"}}\n\n',
            ));
            controller.close();
          },
        });
      },
    });

    engine.updateConfig({
      agentId: 'agent-live',
      apiFormats: ['responses'],
      agentFramework: 'langgraph',
      selectedModel: 'glm-5.1',
      thinkingMode: 'auto',
    });

    engine.subscribe(dispatchRunEventToStores);
    useSessionStore.getState().setCurrentSessionId('session-live');
    engine.start({
      text: 'look at image',
      attachments: [],
      sessionId: 'session-live',
    });

    await waitForCalls(calls);
    for (let i = 0; i < 20 && engine.stage !== 'idle'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const activity = useStreamingStore.getState().getSessionActivity('session-live');
    const messages = useMessageStore.getState().messages;
    expect(activity?.status).toBe('failed');
    expect(activity?.phase).toBe('运行失败');
    expect(messages.at(-1)?.content).toContain('image_url is only supported by certain models');
  });

  it('treats response.cancelled as a cancelled run instead of a failure', async () => {
    const calls: Record<string, unknown>[] = [];
    const engine = createRunEngine({
      ...createApiFacade(calls),
      async runAgent(body) {
        calls.push(body);
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              'event: response.cancelled\n'
              + 'data: {"status":"cancelled"}\n\n',
            ));
          },
        });
      },
    });

    engine.updateConfig({
      agentId: 'agent-live',
      apiFormats: ['responses'],
      agentFramework: 'langgraph',
      selectedModel: '',
      thinkingMode: 'auto',
    });

    engine.subscribe(dispatchRunEventToStores);
    useSessionStore.getState().setCurrentSessionId('session-live');
    engine.start({
      text: 'cancel me',
      attachments: [],
      sessionId: 'session-live',
    });

    await waitForCalls(calls);
    for (let i = 0; i < 20 && engine.stage !== 'idle'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const activity = useStreamingStore.getState().getSessionActivity('session-live');
    expect(activity?.status).toBe('stopped');
    expect(activity?.phase).toBe('运行已取消');
  });

  it('disconnects the frontend stream without adding a stopped system message', async () => {
    const calls: Record<string, unknown>[] = [];
    const engine = createRunEngine({
      ...createApiFacade(calls),
      async runAgent(body) {
        calls.push(body);
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"type":"response.in_progress"}\n\n'));
          },
        });
      },
    });

    engine.updateConfig({
      agentId: 'agent-live',
      apiFormats: ['responses'],
      agentFramework: 'langgraph',
      selectedModel: '',
      thinkingMode: 'auto',
    });

    engine.start({
      text: 'long run',
      attachments: [],
      sessionId: 'session-live',
    });

    await waitForCalls(calls);
    engine.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(engine.stage).toBe('idle');
    expect(useStreamingStore.getState().isStreaming).toBe(false);
    expect(useMessageStore.getState().messages.some((message) => message.role === 'system')).toBe(false);
  });

  it('passes a stable invocation id to RunAgent and uses it for remote cancel', async () => {
    const calls: Record<string, unknown>[] = [];
    const engine = createRunEngine({
      ...createApiFacade(calls),
      async runAgent(body) {
        calls.push(body);
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"type":"response.in_progress"}\n\n'));
          },
        });
      },
    });

    engine.updateConfig({
      agentId: 'agent-live',
      apiFormats: ['responses'],
      agentFramework: 'langgraph',
      selectedModel: '',
      thinkingMode: 'auto',
    });

    engine.start({
      text: 'long run',
      attachments: [],
      sessionId: 'session-live',
    });

    await waitForCalls(calls);
    const invocationId = String(calls[0].InvocationId || '');

    expect(invocationId).toMatch(/^run_/);
    expect(useStreamingStore.getState().currentRunId).toBe(invocationId);

    await engine.cancelRemote(invocationId);

    expect(calls.at(-1)).toEqual({
      cancel: { agentId: 'agent-live', invocationId },
    });
  });
});
