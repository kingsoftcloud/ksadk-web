/**
 * Responses transport adapter (`/v1/responses` official semantics).
 *
 * Normalizes the official `mcp_approval_request` item (delivered either
 * as a stream action or as a SessionEvent record) into the shared
 * Interaction shape. Responses-driven submissions keep the official
 * `mcp_approval_response` path — the adapter marks the record
 * `source: "responses"` so the submit path can route accordingly without
 * components ever branching on protocol.
 */
import type { Interaction } from '../types.js';
import { normalizeInteraction } from './normalize.js';

export type ResponsesApprovalRequest = {
  approvalRequestId: string;
  sessionId: string;
  runId?: string | null;
  name?: string;
  message?: string;
  approvalLevel?: string;
  previousResponseId?: string;
  args?: string;
  requestSchema?: Record<string, unknown> | null;
};

export function interactionFromResponsesApproval(
  request: ResponsesApprovalRequest,
): Interaction | null {
  if (!request.approvalRequestId || !request.sessionId) return null;
  return normalizeInteraction({
    interactionId: request.approvalRequestId,
    sessionId: request.sessionId,
    runId: request.runId ?? null,
    kind: 'approval',
    title: request.name ? `审批：${request.name}` : '人工确认',
    message: request.message || '本次运行需要人工审批后才能继续。',
    requestSchema: request.requestSchema ?? null,
    status: 'pending',
    revision: 1,
    source: 'responses',
    extensions: {
      ...(request.previousResponseId ? { previous_response_id: request.previousResponseId } : {}),
      ...(request.approvalLevel
        ? { approval_level: request.approvalLevel }
        : {}),
      ...(request.args ? { arguments: request.args } : {}),
    },
  });
}

export type ResponsesUserQuestion = {
  questionId: string;
  sessionId: string;
  runId?: string | null;
  questions?: Array<Record<string, unknown>>;
};

/** Build the JSON-schema form the canonical tray renders for a question. */
export function questionRequestSchema(
  questions: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const raw of questions) {
    const question = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const name = String(question.id || question.question_id || question.name || `question_${required.length + 1}`);
    const options = Array.isArray(question.options)
      ? (question.options as unknown[])
          .map(option => (typeof option === 'string'
            ? option
            : String((option as Record<string, unknown>)?.id
              ?? (option as Record<string, unknown>)?.value
              ?? (option as Record<string, unknown>)?.label ?? '')))
          .filter(Boolean)
      : [];
    properties[name] = {
      type: 'string',
      title: String(question.question || question.label || question.title || name),
      ...(options.length ? { enum: options } : {}),
    };
    required.push(name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * Normalize an agent-initiated question (`mcp_user_question`) into the shared
 * Interaction shape as `structured_input`, so the canonical tray renders its
 * chooser form and submits answers through the same SubmitInteraction path.
 */
export function interactionFromResponsesQuestion(
  request: ResponsesUserQuestion,
): Interaction | null {
  if (!request.questionId || !request.sessionId) return null;
  const questions = Array.isArray(request.questions) ? request.questions : [];
  return normalizeInteraction({
    interactionId: request.questionId,
    sessionId: request.sessionId,
    runId: request.runId ?? null,
    kind: 'structured_input',
    title: '询问',
    message: 'Agent 需要你的选择后才能继续。',
    requestSchema: questionRequestSchema(questions),
    status: 'pending',
    revision: 1,
    source: 'responses',
    extensions: { questions },
  });
}

/** Build the official Responses `mcp_approval_response` input item. */
export function buildMcpApprovalResponse(
  approvalRequestId: string,
  approve: boolean,
): Record<string, unknown> {
  return {
    type: 'mcp_approval_response',
    approval_request_id: approvalRequestId,
    approve,
  };
}
