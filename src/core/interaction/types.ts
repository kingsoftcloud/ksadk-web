/**
 * Interaction/v1 client-side types.
 *
 * Mirrors the canonical `contracts/agent-kernel/v1/interaction.schema.json`:
 * one durable Interaction identity per human decision, revision-based
 * optimistic concurrency, and first-wins terminal semantics. Responses
 * approval requests and AG-UI interrupts are transport adapters that
 * normalize into this single shape — components never branch on
 * `approvalProtocol`.
 */
import type { AgentControlReceipt } from '../../types/agent-control.js';

export type InteractionStatus =
  | 'pending'
  | 'resolving'
  | 'failed'
  | 'resolved'
  | 'cancelled'
  | 'expired';

export type InteractionAction = 'approve' | 'reject' | 'submit' | 'cancel';

export type InteractionKind =
  | 'approval'
  | 'structured_input'
  | 'plan_review'
  | 'custom';

/** Which transport surface produced the normalized Interaction. */
export type InteractionSource = 'interaction_v1' | 'responses' | 'agui';

export type A2uiPresentation = {
  /** Production wire is locked to "0.9.1". */
  wireVersion: string;
  /** Pinned catalog digest required before rendering A2UI. */
  catalogDigest: string;
  messages: Array<Record<string, unknown>>;
};

export type InteractionPresentation = {
  a2ui?: A2uiPresentation;
};

export type InteractionOutcome =
  | 'approved'
  | 'rejected'
  | 'submitted'
  | 'cancelled'
  | 'expired';

/**
 * The single normalized Interaction record. Internal provider fields
 * (native targets, checkpoints, permits) never appear here — the server
 * redacts them before emitting public events.
 */
export type Interaction = {
  interactionId: string;
  sessionId: string;
  runId: string | null;
  kind: InteractionKind;
  title: string;
  message: string;
  requestSchema: Record<string, unknown> | null;
  presentation: InteractionPresentation | null;
  status: InteractionStatus;
  revision: number;
  createdAt: string;
  expiresAt: string | null;
  resolvedAt: string | null;
  actor: string | null;
  outcome: InteractionOutcome | null;
  /** Redacted summary of the submitted response; never raw secrets. */
  responseSummary: string | null;
  source: InteractionSource;
  extensions: Record<string, unknown>;
};

export type InteractionEvent =
  | { type: 'interaction_requested'; interaction: Interaction }
  | { type: 'interaction_updated'; interaction: Interaction }
  | { type: 'interaction_resolved'; interaction: Interaction }
  | { type: 'interaction_removed'; interactionId: string };

export type InteractionSubmitInput = {
  interactionId: string;
  expectedRevision: number;
  action: InteractionAction;
  response: Record<string, unknown>;
  idempotencyKey: string;
};

export type InteractionReceipt = AgentControlReceipt;

/**
 * Headless public API. Transport-agnostic: every AgentEngine
 * Interaction/v1 action goes through one `respond` call.
 */
export interface InteractionClient {
  listPending(sessionId: string): readonly Interaction[];
  subscribe(listener: (event: InteractionEvent) => void): () => void;
  respond(input: InteractionSubmitInput): Promise<InteractionReceipt>;
}

/** Statuses that may only be set by an authoritative terminal SessionEvent. */
export const TERMINAL_INTERACTION_STATUSES: ReadonlySet<InteractionStatus> =
  new Set(['resolved', 'cancelled', 'expired']);

export function isTerminalInteraction(status: InteractionStatus): boolean {
  return TERMINAL_INTERACTION_STATUSES.has(status);
}

/** Default idempotency key derivation: stable per (id, revision). */
export function interactionIdempotencyKey(
  interactionId: string,
  expectedRevision: number,
): string {
  return `interaction:${interactionId}:revision-${expectedRevision}`;
}

/** Redact a response payload into a short human-readable summary. */
export function summarizeResponse(
  action: InteractionAction,
  response: Record<string, unknown>,
): string {
  const approved = response.approved;
  if (typeof approved === 'boolean') {
    return approved ? '已同意' : '已拒绝';
  }
  const keys = Object.keys(response);
  if (keys.length === 0) {
    return action === 'approve'
      ? '已同意'
      : action === 'reject'
        ? '已拒绝'
        : action === 'cancel'
          ? '已取消'
          : '已提交';
  }
  const preview = keys
    .slice(0, 3)
    .map((key) => {
      const value = response[key];
      const text =
        typeof value === 'string'
          ? value.length > 24 ? `${value.slice(0, 24)}…` : value
          : typeof value === 'object' && value !== null
            ? '[object]'
            : String(value);
      return `${key}=${text}`;
    })
    .join(', ');
  return `${action}(${preview})`;
}
