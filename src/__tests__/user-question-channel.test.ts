import { describe, expect, it, vi } from 'vitest';
import { InteractionClientImpl } from '../core/interaction/client.js';
import { InteractionStore } from '../core/interaction/store.js';

import {
  interactionFromResponsesQuestion,
  questionRequestSchema,
} from '../core/interaction/adapters/responses.js';
import { normalizeResponsesStreamEvent } from '../utils/responses-stream.js';

describe('codex user-question channel (separate from tool approvals)', () => {
  function questionStore() {
    const store = new InteractionStore();
    store.upsert(interactionFromResponsesQuestion({
      questionId: 'question-1', sessionId: 'session-1', runId: 'run-1',
      questions: [{ id: 'goal', question: 'Choose', options: ['code', 'qa'] }],
    })!);
    return store;
  }

  it.each(['submit', 'cancel'] as const)('does not send an unsupported question %s as an approval', async (action) => {
    const store = questionStore();
    const legacyResponsesApproval = vi.fn(async () => true);
    const submitInteraction = vi.fn(async () => ({ status: 'accepted' }));
    const client = new InteractionClientImpl({
      agentId: 'agent-1', store, interactionV1Enabled: false,
      legacyResponsesApproval, submitInteraction,
    });
    const response = { goal: 'code' };
    const receipt = await client.respond({
      interactionId: 'question-1', sessionId: 'session-1', expectedRevision: 1,
      action, response, idempotencyKey: 'question-submit',
    });
    expect(receipt.status).toBe('unsupported');
    expect(legacyResponsesApproval).not.toHaveBeenCalled();
    expect(submitInteraction).not.toHaveBeenCalled();
    expect(store.get('session-1', 'question-1')).toMatchObject({
      status: 'failed', extensions: { submit_error: { code: 'input_transport_unsupported', retryable: false } },
    });
    expect(response).toEqual({ goal: 'code' });
  });

  it('passes all answers through Interaction/v1 and waits for authoritative completion', async () => {
    const store = questionStore();
    const legacyResponsesApproval = vi.fn();
    const submitInteraction = vi.fn(async () => ({ schema_version: 1, command_id: 'cmd-1', status: 'accepted' }));
    const client = new InteractionClientImpl({
      agentId: 'agent-1', store, interactionV1Enabled: true,
      legacyResponsesApproval, submitInteraction,
    });
    await client.respond({ interactionId: 'question-1', sessionId: 'session-1',
      expectedRevision: 1, action: 'submit', response: { goal: 'code' }, idempotencyKey: 'answer-1' });
    expect(submitInteraction).toHaveBeenCalledWith(expect.objectContaining({
      SessionId: 'session-1', RunId: 'run-1', InteractionId: 'question-1',
      Response: { goal: 'code' }, Action: 'submit',
    }));
    expect(legacyResponsesApproval).not.toHaveBeenCalled();
    expect(store.get('session-1', 'question-1')?.status).toBe('resolving');
  });

  it('parses a question item into its own stream action', () => {
    const state: Record<string, unknown> = {};
    const actions = (normalizeResponsesStreamEvent as any)({
      eventName: 'response.output_item.added',
      data: {
        item: {
          id: 'appr_q1',
          type: 'mcp_user_question',
          status: 'in_progress',
          questions: [{ id: 'goal', question: '你今天想完成什么？', options: [{ id: 'code' }, { id: 'qa' }] }],
          run_id: 'run_1',
        },
        response_id: 'resp_1',
      },
      state,
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: 'question_request',
      questionId: 'appr_q1',
      runId: 'run_1',
    });
    expect(actions[0].questions[0].id).toBe('goal');
  });

  it('parses question_resolved into answers without touching approval events', () => {
    const resolved = (normalizeResponsesStreamEvent as any)({
      eventName: 'response.question_resolved',
      data: { question_id: 'appr_q1', answers: { goal: 'code' }, revision: 2 },
      state: {},
    });
    expect(resolved).toEqual([
      { type: 'question_resolved', questionId: 'appr_q1', answers: { goal: 'code' }, revision: 2 },
    ]);
  });

  it('maps a question to a structured_input interaction with an option form', () => {
    const interaction = interactionFromResponsesQuestion({
      questionId: 'appr_q1',
      sessionId: 'sess-1',
      questions: [{ id: 'goal', question: '你今天想完成什么？', options: [{ id: 'code' }, { id: 'qa' }] }],
    });

    expect(interaction?.kind).toBe('structured_input');
    expect(interaction?.requestSchema).toMatchObject({
      type: 'object',
      required: ['goal'],
      properties: { goal: { type: 'string', title: '你今天想完成什么？', enum: ['code', 'qa'] } },
    });
    expect(interaction?.extensions.questions).toHaveLength(1);
  });

  it('builds a schema that keeps question text and options', () => {
    expect(questionRequestSchema([{ id: 'a', text: undefined as unknown as string }])).toMatchObject({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    });
  });
});
