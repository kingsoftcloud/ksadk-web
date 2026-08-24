import { describe, expect, it, vi } from 'vitest';
import { InteractionClientImpl } from '../core/interaction/client.js';
import { interactionFromSessionEvent } from '../core/interaction/adapters/session-events.js';
import { interactionFromResponsesApproval } from '../core/interaction/adapters/responses.js';
import { interactionFromAguiInterrupt } from '../core/interaction/adapters/agui.js';
import { interactionIdempotencyKey } from '../core/interaction/types.js';

const REQUESTED_EVENT = {
  schema_version: 1,
  event_id: 'evt-1',
  session_id: 'session-1',
  seq: 1,
  timestamp: '2026-08-19T00:00:00Z',
  family: 'control',
  family_version: 1,
  event_type: 'interaction.requested',
  run_id: 'run-1',
  payload: {
    interaction: {
      interaction_id: 'int-1',
      session_id: 'session-1',
      run_id: 'run-1',
      kind: 'approval',
      revision: 1,
      created_at: '2026-08-19T00:00:00Z',
    },
  },
};

function okReceipt() {
  return { schema_version: 1, command_id: 'cmd-1', status: 'accepted' };
}

describe('refresh and replay', () => {
  it('restores a pending interaction from replayed history without a second request', async () => {
    const submitInteraction = vi.fn();
    const client = new InteractionClientImpl({
      agentId: 'agent-1',
      submitInteraction,
    });

    client.ingestHistory([
      interactionFromSessionEvent(REQUESTED_EVENT)!,
    ]);

    expect(client.listPending('session-1')).toHaveLength(1);
    expect(client.listPending('session-1')[0].interactionId).toBe('int-1');
    expect(submitInteraction).not.toHaveBeenCalled();
  });

  it('restores pending interactions from all three transports on refresh', () => {
    const submitInteraction = vi.fn();
    const client = new InteractionClientImpl({
      agentId: 'agent-1',
      submitInteraction,
    });

    client.ingestHistory([
      interactionFromSessionEvent(REQUESTED_EVENT)!,
      interactionFromResponsesApproval({
        approvalRequestId: 'int-2',
        sessionId: 'session-1',
        runId: 'run-1',
      })!,
      interactionFromAguiInterrupt({
        interruptId: 'int-3',
        sessionId: 'session-1',
        runId: 'run-1',
      })!,
    ]);

    expect(client.listPending('session-1').map((i) => i.interactionId)).toEqual([
      'int-1',
      'int-2',
      'int-3',
    ]);
    expect(submitInteraction).not.toHaveBeenCalled();
  });

  it('replay after a completed submit does not create a second request', async () => {
    const submitInteraction = vi.fn().mockResolvedValue(okReceipt());
    const client = new InteractionClientImpl({
      agentId: 'agent-1',
      submitInteraction,
    });
    client.ingest(interactionFromSessionEvent(REQUESTED_EVENT)!);
    await client.respond({
      interactionId: 'int-1',
      expectedRevision: 1,
      action: 'approve',
      response: { approved: true },
      idempotencyKey: interactionIdempotencyKey('int-1', 1),
    });
    expect(submitInteraction).toHaveBeenCalledTimes(1);

    // Refresh replays the full history including the requested event.
    client.ingestHistory([interactionFromSessionEvent(REQUESTED_EVENT)!]);
    // And the server-side resolved fact:
    client.ingestHistory([
      interactionFromSessionEvent({
        ...REQUESTED_EVENT,
        event_type: 'interaction.resolved',
        payload: {
          interaction_id: 'int-1',
          outcome: 'approved',
          actor: 'user-1',
          resolved_at: '2026-08-19T00:01:00Z',
        },
      })!,
    ]);

    expect(client.listPending('session-1')).toHaveLength(0);
    expect(submitInteraction).toHaveBeenCalledTimes(1);
  });

  it('a second respond after replay of the terminal fact is a local duplicate', async () => {
    const submitInteraction = vi.fn().mockResolvedValue(okReceipt());
    const client = new InteractionClientImpl({
      agentId: 'agent-1',
      submitInteraction,
    });
    client.ingest(interactionFromSessionEvent(REQUESTED_EVENT)!);
    await client.respond({
      interactionId: 'int-1',
      expectedRevision: 1,
      action: 'approve',
      response: { approved: true },
      idempotencyKey: interactionIdempotencyKey('int-1', 1),
    });
    // Still resolving: a receipt is not a terminal fact.
    expect(client.store.get('session-1', 'int-1')!.status).toBe('resolving');

    // Replay of the authoritative terminal fact converges the record.
    client.ingestHistory([
      interactionFromSessionEvent({
        ...REQUESTED_EVENT,
        event_type: 'interaction.resolved',
        payload: {
          interaction_id: 'int-1',
          outcome: 'approved',
          actor: 'user-1',
          resolved_at: '2026-08-19T00:01:00Z',
        },
      })!,
    ]);

    const second = await client.respond({
      interactionId: 'int-1',
      expectedRevision: 1,
      action: 'reject',
      response: { approved: false },
      idempotencyKey: interactionIdempotencyKey('int-1', 1),
    });

    expect(second.status).toBe('duplicate');
    expect(submitInteraction).toHaveBeenCalledTimes(1);
    // First-wins outcome is preserved.
    const record = client.listPending('session-1');
    expect(record).toHaveLength(0);
  });

  it('a resolving record converges to resolved when replay contains the terminal event', async () => {
    const submitInteraction = vi.fn().mockResolvedValue(okReceipt());
    const client = new InteractionClientImpl({
      agentId: 'agent-1',
      submitInteraction,
    });
    client.ingest(interactionFromSessionEvent(REQUESTED_EVENT)!);
    await client.respond({
      interactionId: 'int-1',
      expectedRevision: 1,
      action: 'approve',
      response: { approved: true },
      idempotencyKey: interactionIdempotencyKey('int-1', 1),
    });
    expect(client.store.get('session-1', 'int-1')!.status).toBe('resolving');

    // Disconnect/replay: the event stream already carries the terminal
    // fact — the resolving record must converge immediately.
    client.ingestHistory([
      interactionFromSessionEvent(REQUESTED_EVENT)!,
      interactionFromSessionEvent({
        ...REQUESTED_EVENT,
        event_type: 'interaction.resolved',
        payload: {
          interaction_id: 'int-1',
          outcome: 'approved',
          actor: 'user-1',
          resolved_at: '2026-08-19T00:01:00Z',
        },
      })!,
    ]);
    expect(client.store.get('session-1', 'int-1')!.status).toBe('resolved');
    expect(client.listPending('session-1')).toHaveLength(0);
    expect(submitInteraction).toHaveBeenCalledTimes(1);
  });

  it('a resolved record keeps the requested snapshot fields (title, kind, request_schema)', () => {
    const client = new InteractionClientImpl({
      agentId: 'agent-1',
      submitInteraction: vi.fn(),
    });
    client.ingestHistory([
      interactionFromSessionEvent({
        ...REQUESTED_EVENT,
        payload: {
          interaction: {
            ...REQUESTED_EVENT.payload.interaction,
            title: '部署确认',
            message: '请选择部署目标',
            request_schema: {
              type: 'object',
              properties: { deploy_target: { type: 'string' } },
            },
          },
        },
      })!,
    ]);
    const resolved = interactionFromSessionEvent({
      ...REQUESTED_EVENT,
      event_type: 'interaction.resolved',
      event_id: 'evt-2',
      payload: {
        interaction_id: 'int-1',
        outcome: 'submitted',
        actor: 'user',
        resolved_at: '2026-08-19T00:01:00Z',
      },
    });

    const seen: unknown[] = [];
    client.subscribe((event) => {
      if (event.type === 'interaction_resolved') seen.push(event.interaction);
    });
    client.ingestHistory([resolved!]);
    const record = seen[0] as (typeof seen)[0] & {
      title: string;
      requestSchema: Record<string, unknown> | null;
    };
    expect(record).toBeDefined();
    expect(record.status).toBe('resolved');
    expect(record.title).toBe('部署确认');
    expect(record.requestSchema).toEqual({
      type: 'object',
      properties: { deploy_target: { type: 'string' } },
    });
  });

  it('expires pending interactions on replay of expiry events', () => {
    const submitInteraction = vi.fn();
    const client = new InteractionClientImpl({
      agentId: 'agent-1',
      submitInteraction,
    });
    client.ingestHistory([interactionFromSessionEvent(REQUESTED_EVENT)!]);
    client.ingestHistory([
      interactionFromSessionEvent({
        ...REQUESTED_EVENT,
        event_type: 'interaction.expired',
        payload: { interaction_id: 'int-1' },
      })!,
    ]);
    expect(client.listPending('session-1')).toHaveLength(0);
  });
});
