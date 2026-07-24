import { describe, expect, it, vi } from 'vitest';
import { AguiRunClient } from '../core/run/agui.js';
import type { RunEvent } from '../core/run/types.js';

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('AguiRunClient', () => {
  it('uses HttpAgent and projects official text, tool, reasoning, and activity events', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return sse([
        { type: 'RUN_STARTED', threadId: 'session-1', runId: 'run-1' },
        { type: 'REASONING_MESSAGE_CONTENT', messageId: 'reasoning-1', delta: 'plan' },
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
        value: expect.stringContaining('https://a2ui.org/specification/v0_9/basic_catalog.json'),
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
