import { describe, expect, it, vi } from 'vitest';
import { restoreLegacyApprovals } from '../core/interaction/legacy-history.js';
import { InteractionStore } from '../core/interaction/store.js';
import { InteractionClientImpl } from '../core/interaction/client.js';
import { mapBackendMessage } from '../utils/messages.js';
import type { Message } from '../components/chat/types.js';

function history(status = 'paused', protocol = 'responses'): Message {
  return mapBackendMessage({ MessageId: 'message-1', Role: 'assistant', ResponseId: 'response-1',
    InvocationId: 'run-1', ToolEvents: [{ Name: 'query', Status: status,
      ApprovalRequestId: 'approval-1', Protocol: protocol }] });
}

describe('legacy approval history', () => {
  it.each(['responses', 'ag-ui'])('restores %s ToolEvents and duplicate blocks to one record', protocol => {
    const store = new InteractionStore();
    const message = history('paused', protocol);
    restoreLegacyApprovals(store, 'session-1', [message, message]);
    expect(store.listPending('session-1')).toHaveLength(1);
    expect(store.get('session-1', 'approval-1')).toMatchObject({
      source: protocol === 'ag-ui' ? 'agui' : 'responses', runId: 'run-1', revision: 1,
    });
  });

  it('keeps distinct approvals for repeated calls to the same tool', () => {
    const store = new InteractionStore();
    const message = mapBackendMessage({ Role: 'assistant', ToolEvents: [
      { Name: 'query', ApprovalRequestId: 'old', Status: 'denied' },
      { Name: 'query', ApprovalRequestId: 'new', Status: 'paused' },
    ] });
    restoreLegacyApprovals(store, 'session-1', [message]);
    expect(store.listAll('session-1')).toHaveLength(2);
    expect(store.listPending('session-1').map(record => record.interactionId)).toEqual(['new']);
  });

  it.each(['approved', 'denied', 'rejected', 'cancelled', 'expired'])('does not revive %s history on replay', status => {
    const store = new InteractionStore();
    restoreLegacyApprovals(store, 'session-1', [history(status)]);
    restoreLegacyApprovals(store, 'session-1', [history()]);
    expect(store.listPending('session-1')).toHaveLength(0);
    expect(store.get('session-1', 'approval-1')?.outcome).toBe(
      status === 'approved' ? 'approved' : ['cancelled', 'expired'].includes(status) ? 'cancelled' : 'rejected',
    );
  });

  it.each(['completed', 'failed', 'running'])('does not invent a pending decision from %s tool status', status => {
    const store = new InteractionStore();
    restoreLegacyApprovals(store, 'session-1', [history(status)]);
    expect(store.listAll('session-1')).toHaveLength(0);
  });

  it('does not synthesize revision 1 for canonical items or downgrade durable records', () => {
    const store = new InteractionStore();
    const message = history();
    restoreLegacyApprovals(store, 'session-1', [{ ...message, eventType: 'conversation_item_v1' }]);
    expect(store.all()).toHaveLength(0);
    restoreLegacyApprovals(store, 'session-1', [message]);
    store.upsert({ ...store.get('session-1', 'approval-1')!, source: 'interaction_v1', revision: 7 });
    restoreLegacyApprovals(store, 'session-1', [history('denied')]);
    expect(store.get('session-1', 'approval-1')).toMatchObject({ source: 'interaction_v1', revision: 7, status: 'pending' });
  });

  it('restores block-only compatibility approvals', () => {
    const store = new InteractionStore();
    restoreLegacyApprovals(store, 'session-1', [{ id: 'block-only', role: 'model', content: '', timestamp: 1,
      blocks: [{ id: 'tool-1', type: 'tool', toolName: 'query', args: '{}', status: 'paused',
        extra: { approvalRequestId: 'approval-1', approvalProtocol: 'responses' } }] }]);
    expect(store.listPending('session-1')).toHaveLength(1);
  });

  it('submits a restored Responses approval with the original response ID once', async () => {
    const store = new InteractionStore();
    const legacyResponsesApproval = vi.fn(async () => true);
    const submitInteraction = vi.fn();
    const client = new InteractionClientImpl({ agentId: 'agent', store, legacyResponsesApproval, submitInteraction });
    restoreLegacyApprovals(store, 'session-1', [history()]);
    const input = { sessionId: 'session-1', interactionId: 'approval-1', expectedRevision: 1,
      action: 'approve' as const, response: {}, idempotencyKey: 'approval-1' };
    await Promise.all([client.respond(input), client.respond(input)]);
    restoreLegacyApprovals(store, 'session-1', [history()]);
    await client.respond(input);
    expect(legacyResponsesApproval).toHaveBeenCalledExactlyOnceWith('approval-1', true, 'response-1');
    expect(submitInteraction).not.toHaveBeenCalled();
    expect(store.listPending('session-1')).toHaveLength(0);
  });

  it('scopes decisions to the selected session even when approval IDs collide', async () => {
    const store = new InteractionStore();
    restoreLegacyApprovals(store, 'session-1', [history()]);
    restoreLegacyApprovals(store, 'session-2', [history()]);
    const submitInteraction = vi.fn(async () => ({ schema_version: 1, status: 'accepted', command_id: 'cmd' }));
    const client = new InteractionClientImpl({ agentId: 'agent', store, interactionV1Enabled: true, submitInteraction });
    const input = { interactionId: 'approval-1', expectedRevision: 1, action: 'approve' as const,
      response: {}, idempotencyKey: 'approval-1' };
    expect((await client.respond(input)).status).toBe('rejected');
    expect(submitInteraction).not.toHaveBeenCalled();
    await client.respond({ ...input, sessionId: 'session-2' });
    expect(submitInteraction).toHaveBeenCalledWith(expect.objectContaining({ SessionId: 'session-2' }));
    expect(store.get('session-1', 'approval-1')?.status).toBe('pending');
    expect(store.get('session-2', 'approval-1')?.status).toBe('resolving');
  });
});
