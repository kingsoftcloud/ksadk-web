/**
 * Interaction/v1 headless module.
 *
 * One Interaction store, one submit path, three transport adapters
 * (Interaction/v1 SessionEvents, Responses `mcp_approval_request`,
 * AG-UI interrupts). Components consume `InteractionClient` /
 * `useInteractions` and never branch on the approval protocol.
 */
export type {
  A2uiPresentation,
  Interaction,
  InteractionAction,
  InteractionClient,
  InteractionEvent,
  InteractionKind,
  InteractionOutcome,
  InteractionPresentation,
  InteractionReceipt,
  InteractionSource,
  InteractionStatus,
  InteractionSubmitInput,
} from './types.js';
export {
  interactionIdempotencyKey,
  isTerminalInteraction,
  summarizeResponse,
} from './types.js';
export { InteractionStore } from './store.js';
export { InteractionClientImpl } from './client.js';
export type { InteractionClientDeps, SubmitInteractionTransport } from './client.js';
export { interactionFromSessionEvent } from './adapters/session-events.js';
export {
  buildMcpApprovalResponse,
  interactionFromResponsesApproval,
} from './adapters/responses.js';
export type { ResponsesApprovalRequest } from './adapters/responses.js';
export { interactionFromAguiInterrupt } from './adapters/agui.js';
export type { AguiInterruptRequest } from './adapters/agui.js';
export {
  A2UI_WIRE_VERSION,
  computeA2uiCatalogDigest,
  validateA2uiPresentation,
} from './a2ui-validate.js';
export type { A2uiRenderMode } from './a2ui-validate.js';

import { InteractionStore } from './store.js';
import { interactionFromSessionEvent } from './adapters/session-events.js';
import { interactionFromResponsesApproval } from './adapters/responses.js';
import { sessionEventRunStatus } from '../../utils/session-events.js';

const RUN_TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'error',
  'cancelled',
  'canceled',
  'aborted',
  'interrupted',
  'resume_failed',
]);
import { interactionFromAguiInterrupt } from './adapters/agui.js';
import type { Interaction } from './types.js';

/**
 * App-wide shared store. Transport ingestion points (run dispatcher,
 * session lifecycle) write here; the app's `InteractionClient` reads and
 * submits through the same store.
 */
export const sharedInteractionStore = new InteractionStore();

/** Ingest an Interaction/v1 (or legacy) SessionEvent record/envelope. */
export function ingestSessionEventRecord(
  raw: unknown,
  fallbackSessionId?: string,
): Interaction | null {
  const interaction = interactionFromSessionEvent(raw, fallbackSessionId);
  if (interaction) {
    sharedInteractionStore.upsert(interaction);
  }
  const envelope = typeof raw === 'object' && raw !== null
    ? raw as Record<string, unknown>
    : null;
  const terminalStatus = envelope
    ? sessionEventRunStatus(envelope as never)
    : null;
  if (terminalStatus !== null && RUN_TERMINAL_STATUSES.has(terminalStatus)) {
    const content = typeof envelope?.Content === 'object' && envelope.Content !== null
      ? envelope.Content as Record<string, unknown>
      : {};
    const payload = typeof content.payload === 'object' && content.payload !== null
      ? content.payload as Record<string, unknown>
      : {};
    const sessionId = String(
      envelope?.SessionId
      || envelope?.session_id
      || fallbackSessionId
      || '',
    );
    const runId = String(
      envelope?.InvocationId
      || envelope?.run_id
      || payload.run_id
      || payload.runId
      || '',
    );
    sharedInteractionStore.markRunTerminal(sessionId, runId);
  }
  return interaction;
}

/** Ingest a RunEngine `approval_requested` event (Responses or AG-UI). */
export function ingestApprovalRequestedEvent(event: {
  approvalRequestId: string;
  protocol: 'ag-ui' | 'responses';
  runId?: string;
  name?: string;
  message?: string;
  args?: string;
  approvalLevel?: string;
  sessionId?: string | null;
}): Interaction | null {
  const sessionId = event.sessionId || '';
  if (!sessionId || !event.approvalRequestId) return null;
  const interaction =
    event.protocol === 'ag-ui'
      ? interactionFromAguiInterrupt({
          interruptId: event.approvalRequestId,
          sessionId,
          name: event.name,
          message: event.message,
          reason: event.approvalLevel,
        })
      : interactionFromResponsesApproval({
          approvalRequestId: event.approvalRequestId,
          sessionId,
          runId: event.runId,
          name: event.name,
          message: event.message,
          args: event.args,
          approvalLevel: event.approvalLevel,
        });
  if (interaction) {
    sharedInteractionStore.upsert(interaction);
  }
  return interaction;
}

/** Ingest the authoritative terminal fact carried by a live approval stream. */
export function ingestApprovalResolvedEvent(event: {
  approvalRequestId: string;
  decision: 'approved' | 'rejected' | 'cancelled';
  revision?: number;
  sessionId?: string | null;
}): Interaction | null {
  const sessionId = event.sessionId || '';
  if (!sessionId || !event.approvalRequestId) return null;
  return ingestSessionEventRecord({
    EventType: 'approval.resolved',
    Content: {
      approvalId: event.approvalRequestId,
      revision: event.revision || 2,
      outcome: event.decision,
      actor: 'user',
      resolvedAt: new Date().toISOString(),
    },
  }, sessionId);
}
