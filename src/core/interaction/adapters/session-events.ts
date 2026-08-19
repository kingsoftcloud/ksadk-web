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
]);

const RESOLVED_EVENT_TYPES = new Set([
  'interaction.resolved',
  'interaction_resolved',
  'ksadk.interaction/v1.resolved',
  'InteractionResolved',
  'interaction.cancelled',
  'interaction.cancel',
  'interaction.expired',
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
    body.InteractionId ||
    payload.interaction_id ||
    payload.InteractionId ||
    '',
  );
  if (!interactionId) return null;

  const sessionId = String(
    envelope.session_id || body.session_id || fallbackSessionId || '',
  );
  if (!sessionId) return null;

  if (REQUESTED_EVENT_TYPES.has(eventType)) {
    return normalizeInteraction({
      interactionId,
      sessionId,
      runId: body.run_id ?? envelope.run_id,
      kind: body.kind ?? 'approval',
      title: body.title,
      message: body.message ?? body.description,
      requestSchema: body.request_schema ?? body.RequestSchema,
      presentation: body.presentation,
      status: 'pending',
      revision: body.revision ?? 1,
      createdAt: body.created_at ?? envelope.timestamp,
      expiresAt: body.expires_at,
      source: 'interaction_v1',
      extensions: body.extensions,
    });
  }

  if (RESOLVED_EVENT_TYPES.has(eventType)) {
    const normalizedEventStatus =
      eventType === 'interaction.cancelled' || eventType === 'interaction.cancel'
        ? 'cancelled'
        : eventType === 'interaction.expired'
          ? 'expired'
          : 'resolved';
    const rawOutcome = String(
      payload.outcome ?? body.outcome ?? body.status ?? '',
    ).toLowerCase();
    const action = String(payload.action ?? body.action ?? '').toLowerCase();
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
      runId: body.run_id ?? envelope.run_id,
      kind: body.kind,
      title: body.title,
      message: body.message,
      requestSchema: body.request_schema,
      presentation: body.presentation,
      status,
      revision: body.revision,
      createdAt: body.created_at ?? envelope.timestamp,
      expiresAt: body.expires_at,
      resolvedAt: payload.resolved_at ?? body.resolved_at ?? envelope.timestamp,
      actor: payload.actor ?? body.actor ?? envelope.actor_ref,
      outcome,
      responseSummary:
        payload.response_summary ??
        body.response_summary ??
        (action ? `${action}` : undefined),
      source: 'interaction_v1',
      extensions: body.extensions,
    });
  }

  return null;
}
