/**
 * Shared normalization helpers for Interaction transport adapters.
 *
 * Every adapter produces the same Interaction shape so the store, tray,
 * and submit path never branch on the transport protocol.
 */
import type {
  Interaction,
  InteractionKind,
  InteractionOutcome,
  InteractionSource,
  InteractionStatus,
} from './types.js';

export type RawInteractionFields = {
  interactionId: string;
  sessionId: string;
  runId?: string | null;
  kind?: unknown;
  title?: unknown;
  message?: unknown;
  requestSchema?: unknown;
  presentation?: unknown;
  status?: unknown;
  revision?: unknown;
  createdAt?: unknown;
  expiresAt?: unknown;
  resolvedAt?: unknown;
  actor?: unknown;
  outcome?: unknown;
  responseSummary?: unknown;
  extensions?: Record<string, unknown>;
  source: InteractionSource;
};

const VALID_KINDS: ReadonlySet<string> = new Set([
  'approval',
  'structured_input',
  'plan_review',
  'custom',
]);

const VALID_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'resolving',
  'resolved',
  'cancelled',
  'expired',
]);

const VALID_OUTCOMES: ReadonlySet<string> = new Set([
  'approved',
  'rejected',
  'submitted',
  'cancelled',
  'expired',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function normalizeInteraction(fields: RawInteractionFields): Interaction {
  const kind = String(fields.kind || 'approval');
  const status = String(fields.status || 'pending');
  const outcome = String(fields.outcome || '');
  const presentation = asRecord(fields.presentation);
  const a2ui = presentation ? asRecord(presentation.a2ui) : null;

  return {
    interactionId: fields.interactionId,
    sessionId: fields.sessionId,
    runId: stringOrNull(fields.runId),
    kind: (VALID_KINDS.has(kind) ? kind : 'custom') as InteractionKind,
    title: typeof fields.title === 'string' && fields.title ? fields.title : '人工确认',
    message: typeof fields.message === 'string' && fields.message
      ? fields.message
      : '本次运行需要人工处理后才能继续。',
    requestSchema: asRecord(fields.requestSchema),
    presentation: a2ui
      ? {
          a2ui: {
            wireVersion: String(a2ui.wire_version ?? a2ui.wireVersion ?? ''),
            catalogDigest: String(a2ui.catalog_digest ?? a2ui.catalogDigest ?? ''),
            messages: Array.isArray(a2ui.messages)
              ? (a2ui.messages.filter((entry) => typeof entry === 'object') as Array<Record<string, unknown>>)
              : [],
          },
        }
      : null,
    status: (VALID_STATUSES.has(status) ? status : 'pending') as InteractionStatus,
    revision: Number.isFinite(Number(fields.revision)) && Number(fields.revision) > 0
      ? Number(fields.revision)
      : 1,
    createdAt: stringOrNull(fields.createdAt) || new Date().toISOString(),
    expiresAt: stringOrNull(fields.expiresAt),
    resolvedAt: stringOrNull(fields.resolvedAt),
    actor: stringOrNull(fields.actor),
    outcome: (VALID_OUTCOMES.has(outcome) ? outcome : null) as InteractionOutcome | null,
    responseSummary: stringOrNull(fields.responseSummary),
    source: fields.source,
    extensions: fields.extensions || {},
  };
}
