import { describe, expect, it } from 'vitest';

import {
  interactionFromResponsesQuestion,
  questionRequestSchema,
} from '../core/interaction/adapters/responses.js';
import { normalizeResponsesStreamEvent } from '../utils/responses-stream.js';

describe('codex user-question channel (separate from tool approvals)', () => {
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
