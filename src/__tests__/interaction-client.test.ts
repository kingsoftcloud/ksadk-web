import { describe, expect, it, vi } from 'vitest';
import { InteractionClientImpl } from '../core/interaction/client.js';
import { InteractionStore } from '../core/interaction/store.js';
import { interactionFromSessionEvent } from '../core/interaction/adapters/session-events.js';
import { interactionFromResponsesApproval } from '../core/interaction/adapters/responses.js';
import { interactionFromAguiInterrupt } from '../core/interaction/adapters/agui.js';
import { interactionIdempotencyKey } from '../core/interaction/types.js';

function okReceipt(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    command_id: 'cmd-1',
    status: 'accepted',
    ...overrides,
  };
}

/** Equivalent pending approval expressed by each transport. */
const FIXTURES = {
  interactionV1: {
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
        request_schema: { type: 'object' },
      },
    },
  },
  responses: null as unknown as ReturnType<typeof interactionFromResponsesApproval>,
  agui: null as unknown as ReturnType<typeof interactionFromAguiInterrupt>,
};

FIXTURES.responses = interactionFromResponsesApproval({
  approvalRequestId: 'int-1',
  sessionId: 'session-1',
  runId: 'run-1',
});

FIXTURES.agui = interactionFromAguiInterrupt({
  interruptId: 'int-1',
  sessionId: 'session-1',
  runId: 'run-1',
});

describe('three-source normalization', () => {
  it('normalizes Responses, AG-UI, and Interaction/v1 requests to the same Interaction shape', () => {
    const v1 = interactionFromSessionEvent(FIXTURES.interactionV1);
    expect(v1).not.toBeNull();
    expect(v1!.interactionId).toBe('int-1');
    expect(v1!.sessionId).toBe('session-1');
    expect(v1!.status).toBe('pending');
    expect(v1!.kind).toBe('approval');
    expect(v1!.revision).toBe(1);
    expect(v1!.source).toBe('interaction_v1');

    for (const interaction of [FIXTURES.responses, FIXTURES.agui]) {
      expect(interaction).not.toBeNull();
      expect(interaction!.interactionId).toBe('int-1');
      expect(interaction!.sessionId).toBe('session-1');
      expect(interaction!.status).toBe('pending');
      expect(interaction!.kind).toBe('approval');
      expect(interaction!.revision).toBe(1);
    }
  });

  it('resolves Interaction/v1 terminal events with outcome, not a fifth event type', () => {
    const resolved = interactionFromSessionEvent({
      ...FIXTURES.interactionV1,
      event_type: 'interaction.resolved',
      payload: {
        interaction_id: 'int-1',
        outcome: 'rejected',
        resolved_at: '2026-08-19T00:01:00Z',
        actor: 'user-2',
      },
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe('resolved');
    expect(resolved!.outcome).toBe('rejected');
    expect(resolved!.actor).toBe('user-2');
  });
});

describe('single submit path', () => {
  it('routes every Interaction/v1 action through SubmitInteraction exactly once', async () => {
    const submitInteraction = vi.fn().mockResolvedValue(okReceipt());
    const client = new InteractionClientImpl({
      agentId: 'agent-1',
      submitInteraction,
    });
    client.ingest(interactionFromSessionEvent(FIXTURES.interactionV1)!);

    const receipt = await client.respond({
      interactionId: 'int-1',
      expectedRevision: 1,
      action: 'approve',
      response: { approved: true },
      idempotencyKey: interactionIdempotencyKey('int-1', 1),
    });

    expect(receipt.status).toBe('accepted');
    expect(submitInteraction).toHaveBeenCalledTimes(1);
    expect(submitInteraction).toHaveBeenCalledWith({
      AgentId: 'agent-1',
      SessionId: 'session-1',
      RunId: 'run-1',
      InteractionId: 'int-1',
      ExpectedRevision: 1,
      Action: 'approve',
      Response: { approved: true },
      IdempotencyKey: 'interaction:int-1:revision-1',
    });
    expect(client.listPending('session-1')).toHaveLength(0);
  });

  it('keeps the official mcp_approval_response path for pure /v1/responses clients', async () => {
    const submitInteraction = vi.fn();
    const legacyResponsesApproval = vi.fn();
    const client = new InteractionClientImpl({
      agentId: 'agent-1',
      submitInteraction,
      legacyResponsesApproval,
    });
    client.ingest(FIXTURES.responses!);

    const receipt = await client.respond({
      interactionId: 'int-1',
      expectedRevision: 1,
      action: 'approve',
      response: { approved: true },
      idempotencyKey: interactionIdempotencyKey('int-1', 1),
    });

    expect(receipt.status).toBe('accepted');
    expect(legacyResponsesApproval).toHaveBeenCalledWith('int-1', true);
    expect(submitInteraction).not.toHaveBeenCalled();
  });

  it('routes AG-UI records through resumeAguiInterrupt without SubmitInteraction', async () => {
    const submitInteraction = vi.fn();
    const legacyAguiResume = vi.fn().mockReturnValue(true);
    const client = new InteractionClientImpl({
      agentId: 'agent-1',
      submitInteraction,
      legacyAguiResume,
    });
    client.ingest(FIXTURES.agui!);

    await client.respond({
      interactionId: 'int-1',
      expectedRevision: 1,
      action: 'reject',
      response: { approved: false },
      idempotencyKey: interactionIdempotencyKey('int-1', 1),
    });

    expect(legacyAguiResume).toHaveBeenCalledWith('int-1', 'resolved', { approved: false });
    expect(submitInteraction).not.toHaveBeenCalled();
  });

  it('never sends a second request for a double click', async () => {
    const submitInteraction = vi.fn(
      () => new Promise((resolve) => setTimeout(() => resolve(okReceipt()), 20)),
    );
    const client = new InteractionClientImpl({
      agentId: 'agent-1',
      submitInteraction,
    });
    client.ingest(interactionFromSessionEvent(FIXTURES.interactionV1)!);

    const [first, second] = await Promise.all([
      client.respond({
        interactionId: 'int-1',
        expectedRevision: 1,
        action: 'approve',
        response: { approved: true },
        idempotencyKey: interactionIdempotencyKey('int-1', 1),
      }),
      client.respond({
        interactionId: 'int-1',
        expectedRevision: 1,
        action: 'approve',
        response: { approved: true },
        idempotencyKey: interactionIdempotencyKey('int-1', 1),
      }),
    ]);

    expect(submitInteraction).toHaveBeenCalledTimes(1);
    expect(first.status).toBe('accepted');
    expect(second.status).toBe('duplicate');
  });

  it('treats a first-wins rejection from another tab as a failed submit with the server error', async () => {
    const submitInteraction = vi.fn().mockResolvedValue(
      okReceipt({
        status: 'rejected',
        error: {
          code: 'interaction_already_resolved',
          message: 'first-wins',
          retryable: false,
        },
      }),
    );
    const client = new InteractionClientImpl({
      agentId: 'agent-1',
      submitInteraction,
    });
    client.ingest(interactionFromSessionEvent(FIXTURES.interactionV1)!);

    const receipt = await client.respond({
      interactionId: 'int-1',
      expectedRevision: 1,
      action: 'approve',
      response: { approved: true },
      idempotencyKey: interactionIdempotencyKey('int-1', 1),
    });

    expect(receipt.status).toBe('rejected');
    const record = client.store.get('session-1', 'int-1')!;
    expect(record.status).toBe('failed');
    const error = record.extensions.submit_error as { code: string; message: string };
    expect(error.code).toBe('interaction_already_resolved');
    expect(error.message).toBe('first-wins');
  });
});

describe('receipts are not terminal facts', () => {
  it('keeps the record resolving after an accepted receipt; only the SessionEvent resolves it', async () => {
    const submitInteraction = vi.fn().mockResolvedValue(okReceipt());
    const client = new InteractionClientImpl({
      agentId: 'agent-1',
      submitInteraction,
    });
    client.ingest(interactionFromSessionEvent(FIXTURES.interactionV1)!);

    const receipt = await client.respond({
      interactionId: 'int-1',
      expectedRevision: 1,
      action: 'approve',
      response: { approved: true },
      idempotencyKey: interactionIdempotencyKey('int-1', 1),
    });

    expect(receipt.status).toBe('accepted');
    // Receipt proves the command entered the durable Inbox — not a
    // terminal state. The UI keeps showing "resolving".
    expect(client.store.get('session-1', 'int-1')!.status).toBe('resolving');

    // The authoritative terminal fact is the SessionEvent.
    client.ingest(
      interactionFromSessionEvent({
        ...FIXTURES.interactionV1,
        event_type: 'interaction.resolved',
        payload: {
          interaction_id: 'int-1',
          outcome: 'approved',
          actor: 'user',
          resolved_at: '2026-08-19T00:01:00Z',
        },
      })!,
    );
    const resolved = client.store.get('session-1', 'int-1')!;
    expect(resolved.status).toBe('resolved');
    expect(resolved.outcome).toBe('approved');
  });

  it('never resolves to cancelled off a duplicate receipt either', async () => {
    const submitInteraction = vi.fn().mockResolvedValue(
      okReceipt({ status: 'duplicate' }),
    );
    const client = new InteractionClientImpl({
      agentId: 'agent-1',
      submitInteraction,
    });
    client.ingest(interactionFromSessionEvent(FIXTURES.interactionV1)!);

    await client.respond({
      interactionId: 'int-1',
      expectedRevision: 1,
      action: 'cancel',
      response: {},
      idempotencyKey: interactionIdempotencyKey('int-1', 1),
    });

    expect(client.store.get('session-1', 'int-1')!.status).toBe('resolving');
  });

  it('a second respond while the record is resolving is a local duplicate', async () => {
    const submitInteraction = vi.fn().mockResolvedValue(okReceipt());
    const client = new InteractionClientImpl({
      agentId: 'agent-1',
      submitInteraction,
    });
    client.ingest(interactionFromSessionEvent(FIXTURES.interactionV1)!);
    await client.respond({
      interactionId: 'int-1',
      expectedRevision: 1,
      action: 'approve',
      response: { approved: true },
      idempotencyKey: interactionIdempotencyKey('int-1', 1),
    });
    expect(submitInteraction).toHaveBeenCalledTimes(1);

    const second = await client.respond({
      interactionId: 'int-1',
      expectedRevision: 1,
      action: 'approve',
      response: { approved: true },
      idempotencyKey: interactionIdempotencyKey('int-1', 1),
    });
    expect(second.status).toBe('duplicate');
    expect(submitInteraction).toHaveBeenCalledTimes(1);
    expect(client.store.get('session-1', 'int-1')!.status).toBe('resolving');
  });

  it('reverts a retryable queue_full receipt to pending', async () => {
    const submitInteraction = vi.fn().mockResolvedValue(
      okReceipt({
        status: 'queue_full',
        error: {
          code: 'queue_full',
          message: 'inbox queue is full',
          retryable: true,
        },
      }),
    );
    const client = new InteractionClientImpl({
      agentId: 'agent-1',
      submitInteraction,
    });
    client.ingest(interactionFromSessionEvent(FIXTURES.interactionV1)!);

    const receipt = await client.respond({
      interactionId: 'int-1',
      expectedRevision: 1,
      action: 'approve',
      response: { approved: true },
      idempotencyKey: interactionIdempotencyKey('int-1', 1),
    });
    expect(receipt.status).toBe('queue_full');
    expect(client.store.get('session-1', 'int-1')!.status).toBe('pending');
  });
});

describe('store first-wins semantics', () => {
  it('never regresses a terminal record to pending', () => {
    const store = new InteractionStore();
    const pending = interactionFromSessionEvent(FIXTURES.interactionV1)!;
    store.upsert(pending);
    store.upsert({
      ...pending,
      status: 'resolved',
      outcome: 'approved',
      actor: 'user-1',
      resolvedAt: '2026-08-19T00:01:00Z',
    });
    // A late/replayed requested event must not resurrect the decision.
    const event = store.upsert(pending);
    const record = store.get('session-1', 'int-1')!;
    expect(record.status).toBe('resolved');
    expect(record.outcome).toBe('approved');
    expect(event.type).toBe('interaction_updated');
  });

  it('expires pending records via the expired terminal event', () => {
    const store = new InteractionStore();
    store.upsert(interactionFromSessionEvent(FIXTURES.interactionV1)!);
    store.upsert(
      interactionFromSessionEvent({
        ...FIXTURES.interactionV1,
        event_type: 'interaction.expired',
        payload: { interaction_id: 'int-1' },
      })!,
    );
    expect(store.get('session-1', 'int-1')!.status).toBe('expired');
    expect(store.get('session-1', 'int-1')!.outcome).toBe('expired');
  });
});
