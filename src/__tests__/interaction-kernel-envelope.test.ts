import { describe, expect, it } from 'vitest';
import { interactionFromSessionEvent } from '../core/interaction/adapters/session-events.js';
import { KernelRunEventTranslator } from '../core/stream/kernel-events.js';

function envelope(kind = 'approval') {
  return {
    schema_version: 1, family: 'interaction', family_version: 1, seq: 19,
    event_id: 'event-19', event_type: 'interaction.requested',
    session_id: 'parent-session', run_id: 'parent-run', timestamp: '2026-09-26T20:38:40Z',
    payload: {
      schema_version: 1, event_type: 'interaction.requested', interaction_id: 'interaction-1',
      session_id: 'parent-session', run_id: 'parent-run', revision: 3, kind,
      request: { kind, expires_at: '2026-09-26T20:43:40Z',
        presentation: { title: 'expert', description: 'Provide an answer' },
        request_schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
      },
    },
  };
}

describe('canonical Kernel interaction envelopes', () => {
  it.each(['persisted', 'direct', 'translated'])('retains parent ownership and request schema for %s events', mode => {
    const event = envelope('structured_input');
    const raw = mode === 'persisted'
      ? { EventType: event.event_type, InvocationId: event.run_id, Content: { session_event: event } }
      : mode === 'translated' ? new KernelRunEventTranslator(event.session_id).translate(event) : event;
    const interaction = interactionFromSessionEvent(raw, 'fallback-session');
    expect(interaction).not.toBeNull();
    expect(interaction).toMatchObject({ interactionId: 'interaction-1', sessionId: 'parent-session',
      runId: 'parent-run', revision: 3, title: 'expert', status: 'pending',
      expiresAt: '2026-09-26T20:43:40Z', requestSchema: event.payload.request.request_schema });
  });
  it('settles the persisted original interaction without losing its identity', () => {
    const event = envelope();
    event.event_type = 'interaction.resolved';
    const payload = { ...event.payload, event_type: event.event_type, outcome: 'approved', revision: 4 };
    const interaction = interactionFromSessionEvent({ EventType: event.event_type,
      Content: { session_event: { ...event, payload } } });
    expect(interaction).toMatchObject({ interactionId: 'interaction-1', sessionId: 'parent-session',
      runId: 'parent-run', status: 'resolved', outcome: 'approved', revision: 4 });
  });
});
