import { expect, it } from 'vitest';
import { ingestSessionEventRecord, sharedInteractionStore } from '../core/interaction/index.js';

it('keeps MCP approval pending when another tool completes during replay', () => {
  const sessionId = 'mcp-replay-status';
  const runId = 'mcp-run';
  ingestSessionEventRecord({
    EventType: 'a2ui.interaction',
    InvocationId: runId,
    Content: {
      interactionId: 'mcp-approval', kind: 'form', revision: 1,
      inputSchema: { type: 'object', properties: {} },
    },
  }, sessionId);
  ingestSessionEventRecord({
    EventType: 'command.completed', InvocationId: runId, Content: { status: 'completed' },
  }, sessionId);
  expect(sharedInteractionStore.listAll(sessionId)[0].status).toBe('pending');
  ingestSessionEventRecord({
    EventType: 'run.completed', InvocationId: runId, Content: { status: 'completed' },
  }, sessionId);
  expect(sharedInteractionStore.listAll(sessionId)[0].status).not.toBe('pending');
});
