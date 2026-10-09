import { expect, it } from 'vitest';
import { ResponsesProtocol } from '../core/stream/responses-protocol.js';
import { interactionFromSessionEvent } from '../core/interaction/adapters/session-events.js';

it('carries structured input schema and durable ownership through the Responses stream', () => {
  const protocol = new ResponsesProtocol();
  const frame = { family: 'interaction', event_type: 'interaction.requested', seq: 25,
    session_id: 'parent-session', run_id: 'parent-run', payload: {
      interaction_id: 'input-1', kind: 'structured_input', revision: 2,
      request: { kind: 'structured_input', request_schema: {
        type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } },
    } };
  const actions = protocol.parse({ eventName: 'interaction.requested', data: frame }, protocol.createState());
  expect(actions).toHaveLength(1);
  expect(actions[0].type).toBe('canonical_interaction');
  if (actions[0].type !== 'canonical_interaction') throw Error('Missing canonical interaction');
  expect(actions[0].interactionId).toBe('input-1');
  expect(interactionFromSessionEvent(actions[0].event)).toMatchObject({
    sessionId: 'parent-session', runId: 'parent-run', kind: 'structured_input', revision: 2,
    requestSchema: frame.payload.request.request_schema, source: 'interaction_v1',
  });
});
