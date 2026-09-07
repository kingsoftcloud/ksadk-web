/**
 * AgentEngine Interaction/v1 SessionEvent adapter.
 *
 * `SessionEventEnvelope.payload` carries the public Interaction facts:
 * event_type `interaction.requested` / `ksadk.interaction/v1.requested`
 * creates a pending Interaction; `interaction.resolved` (outcome in
 * payload) closes it. Rejection is `resolved.outcome="rejected"`, not a
 * fifth terminal event type.
 */
import type { Interaction } from '../types.js';
import { normalizeInteraction } from './normalize.js';

const REQUESTED_EVENT_TYPES = new Set([
  'interaction.requested',
  'interaction_requested',
  'ksadk.interaction/v1.requested',
  'InteractionRequested',
  'approval.requested',
  'a2ui.interaction',
]);

const RESOLVED_EVENT_TYPES = new Set([
  'interaction.resolved',
  'interaction_resolved',
  'ksadk.interaction/v1.resolved',
  'InteractionResolved',
  'interaction.cancelled',
  'interaction.cancel',
  'interaction.expired',
  'approval.resolved',
  'a2ui.action',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Normalize an Interaction/v1 SessionEvent payload (or envelope) into the
 * shared Interaction shape. Returns null when the event is not an
 * interaction event.
 */
export function interactionFromSessionEvent(
  raw: unknown,
  fallbackSessionId?: string,
): Interaction | null {
  const envelope = asRecord(raw);
  if (!envelope) return null;
  const eventType = String(
    envelope.event_type || envelope.EventType || '',
  ).trim();
  if (!eventType) return null;

  const payload = asRecord(envelope.payload ?? envelope.Content) || {};
  const body =
    asRecord(payload.interaction) ||
    asRecord(payload.Interaction) ||
    asRecord(payload.interaction_request) ||
    payload;
  const interactionId = String(
    body.interaction_id ||
    body.interactionId ||
    body.InteractionId ||
    body.approval_id ||
    body.approvalId ||
    payload.interaction_id ||
    payload.interactionId ||
    payload.InteractionId ||
    payload.approval_id ||
    payload.approvalId ||
    '',
  );
  if (!interactionId) return null;

  const sessionId = String(
    envelope.session_id || envelope.SessionId || body.session_id || body.sessionId || fallbackSessionId || '',
  );
  if (!sessionId) return null;

  if (REQUESTED_EVENT_TYPES.has(eventType)) {
    const extensions = {
      ...(asRecord(body.extensions) || {}),
      ...(body.detail !== undefined ? { detail: body.detail } : {}),
      ...((body.call_id ?? body.callId) !== undefined
        ? { call_id: body.call_id ?? body.callId }
        : {}),
    };
    return normalizeInteraction({
      interactionId,
      sessionId,
      runId: body.run_id ?? body.runId ?? envelope.run_id ?? envelope.InvocationId,
      kind: eventType === 'approval.requested' ? 'approval' : body.kind ?? 'approval',
      title: body.title,
      message: body.message ?? body.description ?? asRecord(body.detail)?.command,
      requestSchema: body.request_schema ?? body.requestSchema ?? body.input_schema ?? body.inputSchema ?? body.RequestSchema,
      presentation: body.presentation,
      status: 'pending',
      revision: body.revision ?? 1,
      createdAt: body.created_at ?? body.createdAt ?? envelope.timestamp ?? envelope.Timestamp,
      expiresAt: body.expires_at,
      source: 'interaction_v1',
      extensions,
    });
  }

  if (RESOLVED_EVENT_TYPES.has(eventType)) {
    const extensions = {
      ...(asRecord(body.extensions) || {}),
      ...(body.detail !== undefined ? { detail: body.detail } : {}),
      ...((body.call_id ?? body.callId) !== undefined
        ? { call_id: body.call_id ?? body.callId }
        : {}),
    };
    const normalizedEventStatus =
      eventType === 'interaction.cancelled' || eventType === 'interaction.cancel'
        ? 'cancelled'
        : eventType === 'interaction.expired'
          ? 'expired'
          : 'resolved';
    const rawOutcome = String(
      payload.outcome ?? body.outcome ?? body.status ?? '',
    ).toLowerCase();
    const action = String(
      payload.action ?? body.action ?? payload.name ?? body.name ?? '',
    ).toLowerCase();
    let outcome = rawOutcome;
    if (!outcome) {
      if (action === 'approve') outcome = 'approved';
      else if (action === 'reject') outcome = 'rejected';
      else if (action === 'submit') outcome = 'submitted';
      else if (action === 'cancel' || normalizedEventStatus === 'cancelled') outcome = 'cancelled';
      else if (normalizedEventStatus === 'expired') outcome = 'expired';
      else outcome = 'submitted';
    }
    const status = normalizedEventStatus === 'resolved'
      ? 'resolved'
      : normalizedEventStatus;
    return normalizeInteraction({
      interactionId,
      sessionId,
      runId: body.run_id ?? body.runId ?? envelope.run_id ?? envelope.InvocationId,
      kind: body.kind,
      title: body.title,
      message: body.message,
      requestSchema: body.request_schema,
      presentation: body.presentation,
      status,
      revision: body.revision,
      createdAt: body.created_at ?? envelope.timestamp,
      expiresAt: body.expires_at,
      resolvedAt: payload.resolved_at ?? payload.resolvedAt ?? body.resolved_at ?? body.resolvedAt ?? envelope.timestamp ?? envelope.Timestamp,
      actor: payload.actor ?? body.actor ?? envelope.actor_ref,
      outcome,
      responseSummary:
        payload.response_summary ??
        body.response_summary ??
        (action ? `${action}` : undefined),
      source: 'interaction_v1',
      extensions,
    });
  }

  return null;
}
