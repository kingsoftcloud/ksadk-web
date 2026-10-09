import { expect, it } from 'vitest';
import { InteractionClientImpl, ingestSessionEventRecord, sharedInteractionStore,
  interactionFromResponsesApproval } from '../core/interaction/index.js';
import { KernelRunEventTranslator } from '../core/stream/kernel-events.js';

it('delivers a subscribed rejection to the same pending approval without closing it', async () => {
  const sessionId = 'command-rejection-integration';
  const client = new InteractionClientImpl({ agentId: 'agent-1', store: sharedInteractionStore,
    interactionV1Enabled: true, submitInteraction: async () => ({
      schema_version: 1, status: 'accepted', command_id: 'cmd-rejected',
    }) });
  client.ingest(interactionFromResponsesApproval({ approvalRequestId: 'approval-1', sessionId,
    runId: 'run-1' }));
  await client.respond({ interactionId: 'approval-1', expectedRevision: 1, action: 'approve',
    response: {}, idempotencyKey: 'decision-1' });
  const record = new KernelRunEventTranslator(sessionId).translate({ seq: 23, family: 'control',
    event_type: 'control.command_rejected', command_id: 'cmd-rejected',
    reason: 'runtime_interaction_unavailable' });
  ingestSessionEventRecord(record, sessionId);
  expect(sharedInteractionStore.get(sessionId, 'approval-1')).toMatchObject({
    status: 'failed', extensions: { submit_error: { code: 'runtime_interaction_unavailable' } },
  });
  sharedInteractionStore.clearSession(sessionId);
});
