import type { Interaction } from '../types.js';
import { interactionFromResponsesApproval } from './responses.js';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/**
 * SDK 0.8.5 persists LangGraph's legacy Responses approvals as RuntimeEvent/v2,
 * without an Interaction/v1 revision. Preserve the Responses submit route;
 * these records must never acquire an invented durable CAS revision.
 */
export function interactionFromLegacyRuntimeEvent(
  raw: unknown,
  fallbackSessionId?: string,
): Interaction | null {
  const outer = record(raw);
  const content = record(outer?.Content);
  const event = record(content?.runtime_event);
  if (!event || event.schema_version !== 2 || event.interaction_kind !== 'approval') return null;
  const source = record(event.source);
  if (!['langgraph', 'langchain', 'deepagents'].includes(String(source?.framework))) return null;
  const sessionId = String(outer?.SessionId || fallbackSessionId || '');
  const id = typeof event.interaction_id === 'string' ? event.interaction_id : '';
  if (!sessionId || !id) return null;
  const request = record(event.request);
  const detail = record(request?.detail);
  const response = record(event.response);
  const requested = event.event_type === 'interaction.requested';
  const resolved = event.event_type === 'interaction.resolved';
  // The explicit legacy approval id identifies the native Responses bridge.
  if (requested && (request?.request_type !== 'approval' || detail?.approval_request_id !== id)) return null;
  if (!requested && (!resolved || response?.response_type !== 'approval')) return null;
  const actions = Array.isArray(detail?.action_requests) ? detail.action_requests : [];
  const action = record(actions[0]);
  const args = detail?.arguments ?? action?.args;
  const metadata = record(source?.metadata);
  const interaction = interactionFromResponsesApproval({
    approvalRequestId: id,
    sessionId,
    runId: String(event.run_id || outer?.InvocationId || '') || undefined,
    name: String(detail?.tool_name || action?.name || '') || undefined,
    message: typeof detail?.description === 'string' ? detail.description : undefined,
    args: args === undefined ? undefined : typeof args === 'string' ? args : JSON.stringify(args),
    previousResponseId: typeof metadata?.response_id === 'string' ? metadata.response_id : undefined,
  });
  if (!interaction) return null;
  interaction.createdAt = String(event.timestamp ?? outer?.Timestamp ?? interaction.createdAt);
  if (resolved) {
    const decision = response?.decision;
    if (decision !== 'approved' && decision !== 'rejected' && decision !== 'canceled') return null;
    interaction.status = decision === 'canceled' ? 'cancelled' : 'resolved';
    interaction.outcome = decision === 'canceled' ? 'cancelled' : decision;
    interaction.resolvedAt = interaction.createdAt;
  }
  return interaction;
}
