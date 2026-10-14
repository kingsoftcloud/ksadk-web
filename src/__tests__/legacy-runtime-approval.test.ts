import { afterEach, expect, it } from 'vitest';
import { ingestSessionEventRecord, sharedInteractionStore } from '../core/interaction/index.js';
import { interactionFromLegacyRuntimeEvent } from '../core/interaction/adapters/legacy-runtime-events.js';

const sessionId = 'legacy-runtime-approval';
const runId = 'native-run';
const nativeEvent = (event: Record<string, unknown>) => ({
  SessionId: sessionId, InvocationId: runId, EventType: event.event_type,
  Content: { runtime_event: {
    schema_version: 2, run_id: runId, timestamp: 1791967072,
    source: { framework: 'langgraph' }, ...event,
  } },
});
const requested = nativeEvent({
  event_type: 'interaction.requested', interaction_id: 'approval-1', interaction_kind: 'approval',
  request: { request_type: 'approval', kind: 'tool', detail: {
    approval_request_id: 'approval-1', tool_name: 'start_spark_sql_query',
    action_requests: [{ name: 'start_spark_sql_query', args: { plan_id: 'plan-test' } }],
  } },
});
afterEach(() => sharedInteractionStore.clearSession(sessionId));

it('restores SDK 0.8.5 approvals through their legacy Responses transport', () => {
  expect(interactionFromLegacyRuntimeEvent(requested)).toMatchObject({
    interactionId: 'approval-1', sessionId, runId, source: 'responses', status: 'pending',
    title: '审批：start_spark_sql_query', extensions: { arguments: '{"plan_id":"plan-test"}' },
  });
});
it('keeps waiting approvals through descending interrupted run history', () => {
  ingestSessionEventRecord({ SessionId: sessionId, InvocationId: runId, EventType: 'run_status', Content: { status: 'interrupted' } });
  ingestSessionEventRecord(nativeEvent({ event_type: 'run.interrupted', status: 'interrupted', reason: 'input_required' }));
  ingestSessionEventRecord(requested);
  expect(sharedInteractionStore.listPending(sessionId)).toHaveLength(1);
});
it.each(['approved', 'rejected', 'canceled'])('never resurrects a %s native approval when replay is descending', decision => {
  ingestSessionEventRecord(nativeEvent({ event_type: 'interaction.resolved', interaction_id: 'approval-1', interaction_kind: 'approval', response: { response_type: 'approval', decision } }));
  ingestSessionEventRecord(requested);
  expect(sharedInteractionStore.listPending(sessionId)).toHaveLength(0);
  expect(sharedInteractionStore.get(sessionId, 'approval-1')?.outcome).toBe(decision === 'canceled' ? 'cancelled' : decision);
});
it('expires the approval on an actual terminal run', () => {
  ingestSessionEventRecord(nativeEvent({ event_type: 'run.completed', status: 'completed' }));
  ingestSessionEventRecord(requested);
  expect(sharedInteractionStore.listPending(sessionId)).toHaveLength(0);
});
it('does not invent legacy submissions for unrelated canonical approvals', () => {
  const other = structuredClone(requested);
  delete other.Content.runtime_event.request.detail.approval_request_id;
  expect(interactionFromLegacyRuntimeEvent(other)).toBeNull();
  other.Content.runtime_event.source.framework = 'codex';
  expect(interactionFromLegacyRuntimeEvent(other)).toBeNull();
});
