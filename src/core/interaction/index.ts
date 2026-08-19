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
  return interaction;
}

/** Ingest a RunEngine `approval_requested` event (Responses or AG-UI). */
export function ingestApprovalRequestedEvent(event: {
  approvalRequestId: string;
  protocol: 'ag-ui' | 'responses';
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
          name: event.name,
          message: event.message,
          approvalLevel: event.approvalLevel,
        });
  if (interaction) {
    sharedInteractionStore.upsert(interaction);
  }
  return interaction;
}
