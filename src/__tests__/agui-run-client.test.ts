import { describe, expect, it, vi } from 'vitest';
import { AguiRunClient } from '../core/run/agui.js';
import type { RunEvent } from '../core/run/types.js';
import { interactionFromSessionEvent } from '../core/interaction/adapters/session-events.js';

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('AguiRunClient', () => {
  it.each([false, true])('keeps activity ownership on the original logical run through resume, rehydrated=%s', async rehydrated => {
    const projected: RunEvent[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const client = new AguiRunClient({ url: '/agui', agentId: 'agent', threadId: 'session',
      onEvent: event => projected.push(event), fetch: vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        const start = { type: 'RUN_STARTED', threadId: 'session', runId: body.runId };
        if (!rehydrated && bodies.length === 1) return sse([start, {
          type: 'RUN_FINISHED', threadId: 'session', runId: body.runId,
          outcome: { type: 'interrupt', interrupts: [{ id: 'wait', reason: 'structured_input' }] },
        }]);
        return sse([start,
          { type: 'TEXT_MESSAGE_START', messageId: `${body.runId}:text`, role: 'assistant' },
          { type: 'ACTIVITY_SNAPSHOT', messageId: `${body.runId}:surface`, activityType: 'a2ui-surface',
            content: { surfaceId: 'dynamic-surface', a2ui_operations: [] } },
          { type: 'TEXT_MESSAGE_END', messageId: `${body.runId}:text` },
          { type: 'RUN_FINISHED', threadId: 'session', runId: body.runId, outcome: { type: 'success' } },
        ]);
      }) });
    if (!rehydrated) await client.run('first', 'original-logical-run');
    await client.resume('resume-wire', { interruptId: 'wait', status: 'resolved', payload: { answer: 'yes' },
      ...(rehydrated ? { logicalRunId: 'original-logical-run' } : {}) });
    expect(projected).toContainEqual(expect.objectContaining({ type: 'agui_activity', runId: 'original-logical-run' }));
    expect(projected).toContainEqual({ type: 'assistant_message_created', messageId: 'resume-wire:text', invocationId: 'original-logical-run' });
    expect(bodies.at(-1)).not.toHaveProperty('logicalRunId');
    await client.run('second', 'next-logical-run');
    expect(projected.filter(event => event.type === 'agui_activity').at(-1)).toMatchObject({ runId: 'next-logical-run' });
  });

  it.each(['resolved', 'cancelled', 'expired'])('allows a new turn after authoritative canonical %s without refreshing', async status => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return sse([
        { type: 'RUN_STARTED', threadId: body.threadId, runId: body.runId },
        { type: 'RUN_FINISHED', threadId: body.threadId, runId: body.runId, outcome: body.runId === 'first'
          ? { type: 'interrupt', interrupts: [{ id: 'wait', reason: 'structured_input',
            metadata: { interaction_v1: true, revision: 1, run_id: 'original' } }] }
          : { type: 'success' } },
      ]);
    });
    const client = new AguiRunClient({ url: '/agui', agentId: 'agent', threadId: 'session',
      onEvent: () => {}, fetch: fetchMock as unknown as typeof fetch });
    await client.run('first question', 'first');
    // This is the customer's failure: a canonical submit bypasses HttpAgent.resume().
    await expect(client.run('next question', 'blocked')).rejects.toThrow('pending interrupt(s) not addressed by resume');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fact = interactionFromSessionEvent({ family: 'interaction', session_id: 'session',
      run_id: 'original', event_type: `interaction.${status}`, payload: { interaction_id: 'wait', revision: 2 } })!;
    client.reconcileInteractions([fact]);
    const result = await client.run('next question', 'second');
    expect(result.status).toBe('completed');
    expect(result.pendingInterruptIds).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('preserves unconsumed, unrelated and legacy interrupts during canonical reconciliation', async () => {
    const fetchMock = vi.fn(async () => sse([
      { type: 'RUN_STARTED', threadId: 'session', runId: 'first' },
      { type: 'RUN_FINISHED', threadId: 'session', runId: 'first', outcome: { type: 'interrupt', interrupts: [
        { id: 'one', reason: 'structured_input', metadata: { interaction_v1: true, revision: 2, run_id: 'original' } },
        { id: 'two', reason: 'structured_input', metadata: { interaction_v1: true, revision: 1, run_id: 'original' } },
        { id: 'legacy', reason: 'approval' },
      ] } },
    ]));
    const client = new AguiRunClient({ url: '/agui', agentId: 'agent', threadId: 'session', onEvent: () => {}, fetch: fetchMock });
    await client.run('question', 'first');
    const fact = interactionFromSessionEvent({ family: 'interaction', session_id: 'session', run_id: 'original',
      event_type: 'interaction.resolved', payload: { interaction_id: 'one', revision: 3 } })!;
    client.reconcileInteractions([
      { ...fact, status: 'resolving', extensions: { submit_command_id: 'accepted' } },
      { ...fact, status: 'failed' }, { ...fact, status: 'pending' },
      { ...fact, sessionId: 'another' }, { ...fact, runId: 'another' }, { ...fact, revision: 1 },
      { ...fact, source: 'agui' }, { ...fact, interactionId: 'legacy' },
    ]);
    await expect(client.run('next', 'blocked')).rejects.toThrow('3 pending interrupt(s)');
    client.reconcileInteractions([fact]);
    await expect(client.run('next', 'still-blocked')).rejects.toThrow('2 pending interrupt(s)');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('carries model and policy selections on the recoverable AG-UI path', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const client = new AguiRunClient({
      url: '/agui', agentId: 'agent', threadId: 'session-options', onEvent: () => {},
      fetch: vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)); bodies.push(body);
        return sse([
          { type: 'RUN_STARTED', threadId: body.threadId, runId: body.runId },
          { type: 'RUN_FINISHED', threadId: body.threadId, runId: body.runId, outcome: { type: 'success' } },
        ]);
      }) as unknown as typeof fetch,
    });
    const options = { model: 'selected', modelMetadata: { id: 'selected' },
      modelOptions: { reasoning: { enabled: false } }, toolApprovalMode: 'risk' };
    client.configure(options);
    await client.run('input', 'options-run');
    expect(bodies[0].forwardedProps).toEqual({ ...options, injectA2UITool: true });
  });

  it('projects the durable interaction cursor and keeps the original run identity', async () => {
    const envelope = {
      family: 'interaction', family_version: 1, session_id: 'session-kernel', seq: 19,
      event_id: 'event-wait', event_type: 'interaction.requested', run_id: 'original-run',
      payload: { interaction_id: 'wait', kind: 'structured_input', revision: 1,
        request: { request_schema: { type: 'integer' } } },
    };
    const projected: RunEvent[] = [];
    const client = new AguiRunClient({
      url: '/agui', agentId: 'agent', threadId: 'session-kernel', onEvent: event => projected.push(event),
      fetch: vi.fn(async () => sse([
        { type: 'RUN_STARTED', threadId: 'session-kernel', runId: 'wire-attempt' },
        { type: 'CUSTOM', name: 'ksadk.session_event', value: envelope },
        { type: 'RUN_FINISHED', threadId: 'session-kernel', runId: 'wire-attempt', outcome: {
          type: 'interrupt', interrupts: [{ id: 'wait', reason: 'structured_input', responseSchema: { type: 'integer' },
            metadata: { interaction_v1: true, revision: 1, run_id: 'original-run' } }],
        } },
      ])),
    });
    const result = await client.run('input', 'wire-attempt');
    expect(result.status).toBe('interrupted');
    expect(result.pendingInterruptIds).toEqual(['wait']);
    expect(projected).toContainEqual({ type: 'stream_event', sessionId: 'session-kernel', event: {
      EventId: 'event-wait', EventType: 'interaction.requested', SessionId: 'session-kernel',
      InvocationId: 'original-run', SeqId: 19, Content: { session_event: envelope },
    } });
    expect(projected.filter(event => event.type === 'approval_requested')).toHaveLength(0);
  });

  it.each([false, 0, '', [], { note: null }])('sends the exact JSON answer through the official client: %j', async payload => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(Object.hasOwn(body.resume[0], 'payload')).toBe(true);
      expect(body.resume[0].payload).toEqual(payload);
      return sse([
        { type: 'RUN_STARTED', threadId: 'session-json', runId: body.runId },
        { type: 'RUN_FINISHED', threadId: 'session-json', runId: body.runId, outcome: { type: 'success' } },
      ]);
    });
    const client = new AguiRunClient({ url: '/agui', agentId: 'agent', threadId: 'session-json',
      onEvent: () => {}, fetch: fetchMock as unknown as typeof fetch });
    expect((await client.resume('run-json', { interruptId: 'wait', status: 'resolved', payload })).status).toBe('completed');
  });

  it('rejects root null before the AG-UI transport can normalize it to absence', async () => {
    const fetchMock = vi.fn();
    const client = new AguiRunClient({ url: '/agui', agentId: 'agent', threadId: 'session-json',
      onEvent: () => {}, fetch: fetchMock });
    await expect(client.resume('run-json', { interruptId: 'wait', status: 'resolved', payload: null })).rejects.toThrow('Interaction/v1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses HttpAgent and projects official text, tool, reasoning, and activity events', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return sse([
        { type: 'RUN_STARTED', threadId: 'session-1', runId: 'run-1' },
        { type: 'REASONING_MESSAGE_START', messageId: 'reasoning-1', role: 'reasoning' },
        { type: 'REASONING_MESSAGE_CONTENT', messageId: 'reasoning-1', delta: 'plan' },
        { type: 'REASONING_MESSAGE_END', messageId: 'reasoning-1' },
        { type: 'TEXT_MESSAGE_START', messageId: 'message-1', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'message-1', delta: 'hello' },
        { type: 'TOOL_CALL_START', toolCallId: 'tool-1', toolCallName: 'lookup' },
        { type: 'TOOL_CALL_ARGS', toolCallId: 'tool-1', delta: '{"q":"x"}' },
        { type: 'TOOL_CALL_END', toolCallId: 'tool-1' },
        { type: 'TOOL_CALL_RESULT', messageId: 'tool-result-1', toolCallId: 'tool-1', content: 'ok', role: 'tool' },
        {
          type: 'ACTIVITY_SNAPSHOT',
          messageId: 'surface-1',
          activityType: 'a2ui-surface',
          content: {
            surfaceId: 'surface-1',
            a2ui_operations: [
              { createSurface: { surfaceId: 'surface-1' } },
              {
                updateComponents: {
                  surfaceId: 'surface-1',
                  components: [{ id: 'surface-1-root', component: 'Column', children: [] }],
                },
              },
            ],
          },
        },
        { type: 'TEXT_MESSAGE_END', messageId: 'message-1' },
        { type: 'RUN_FINISHED', threadId: 'session-1', runId: 'run-1', outcome: { type: 'success' } },
      ]);
    });
    const projected: RunEvent[] = [];
    const client = new AguiRunClient({
      url: '/agentengine/agui',
      agentId: 'agent-1',
      threadId: 'session-1',
      fetch: fetchMock,
      onEvent: (event) => projected.push(event),
    });

    const result = await client.run('hello', 'run-1');

    expect(result.status).toBe('completed');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/agentengine/agui');
    expect(calls[0].body).toMatchObject({
      threadId: 'session-1',
      runId: 'run-1',
      forwardedProps: { injectA2UITool: true },
    });
    expect(projected).toContainEqual({ type: 'text_delta', messageId: 'message-1', delta: 'hello' });
    expect(projected).toContainEqual({ type: 'reasoning_delta', messageId: 'reasoning-1', delta: 'plan' });
    expect(projected).toContainEqual({ type: 'tool_result', messageId: 'message-1', name: 'lookup', output: 'ok' });
    expect(projected).toContainEqual({
      type: 'agui_activity',
      runId: 'run-1',
      messageId: 'message-1',
      surfaceId: 'surface-1',
      messages: [
        { createSurface: { surfaceId: 'surface-1' } },
        {
          updateComponents: {
            surfaceId: 'surface-1',
            components: [{ id: 'root', component: 'Column', children: [] }],
          },
        },
      ],
    });
  });

  it('builds the official resume array for the pending interrupt', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const projected: RunEvent[] = [];
    const responses = [
      sse([
        { type: 'RUN_STARTED', threadId: 'session-1', runId: 'run-1' },
        {
          type: 'RUN_FINISHED',
          threadId: 'session-1',
          runId: 'run-1',
          outcome: {
            type: 'interrupt',
            interrupts: [{
              id: 'approval-1',
              reason: 'approval',
              message: 'Approve writing the file?',
              toolCallId: 'tool-1',
              metadata: {
                tool_name: 'write_file',
                arguments: { path: '/tmp/x.txt' },
                approval_level: 'elevated',
              },
            }],
          },
        },
      ]),
      sse([
        { type: 'RUN_STARTED', threadId: 'session-1', runId: 'run-2' },
        { type: 'RUN_FINISHED', threadId: 'session-1', runId: 'run-2', outcome: { type: 'success' } },
      ]),
    ];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      requestBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return responses.shift()!;
    });
    const client = new AguiRunClient({
      url: '/agentengine/agui',
      agentId: 'agent-1',
      threadId: 'session-1',
      fetch: fetchMock,
      onEvent: (event) => projected.push(event),
    });

    expect((await client.run('run command', 'run-1')).status).toBe('interrupted');
    expect(projected).toContainEqual({
      type: 'approval_requested',
      messageId: 'run-1:assistant',
      approvalRequestId: 'approval-1',
      protocol: 'ag-ui',
      name: 'write_file',
      args: '{\n  "path": "/tmp/x.txt"\n}',
      message: 'Approve writing the file?',
      approvalLevel: 'elevated',
    });
    expect((await client.resume('run-2', {
      interruptId: 'approval-1',
      status: 'resolved',
      payload: { decision: 'approve' },
    })).status).toBe('completed');

    expect(requestBodies[1]).toMatchObject({
      threadId: 'session-1',
      runId: 'run-2',
      resume: [{
        interruptId: 'approval-1',
        status: 'resolved',
        payload: { decision: 'approve' },
      }],
    });
    expect(requestBodies[0].context).toEqual(expect.arrayContaining([
      expect.objectContaining({
        description: expect.stringContaining('A2UI Component Schema'),
        value: expect.stringContaining('https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json'),
      }),
    ]));
  });

  it('resumes a durable interrupt after the page is rehydrated', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      requestBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return sse([
        { type: 'RUN_STARTED', threadId: 'session-1', runId: 'run-resume' },
        { type: 'RUN_FINISHED', threadId: 'session-1', runId: 'run-resume', outcome: { type: 'success' } },
      ]);
    });
    const client = new AguiRunClient({
      url: '/agentengine/agui',
      agentId: 'agent-1',
      threadId: 'session-1',
      fetch: fetchMock,
      onEvent: () => {},
    });

    await expect(client.resume('run-resume', {
      interruptId: 'approval-durable-1',
      status: 'resolved',
      payload: { decision: 'approve' },
    })).resolves.toMatchObject({ status: 'completed' });

    expect(requestBodies[0]).toMatchObject({
      threadId: 'session-1',
      runId: 'run-resume',
      resume: [{
        interruptId: 'approval-durable-1',
        status: 'resolved',
        payload: { decision: 'approve' },
      }],
    });
  });
});
