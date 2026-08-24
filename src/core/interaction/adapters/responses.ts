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
    extensions: request.approvalLevel
      ? { approval_level: request.approvalLevel }
      : {},
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
