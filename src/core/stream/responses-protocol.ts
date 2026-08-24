import type { StreamProtocol, StreamAction } from './types.js';
import type { TransportEvent } from '../transport/types.js';
import {
  createResponsesStreamState,
  normalizeResponsesStreamEvent,
} from '../../utils/responses-stream.js';
import {
  responsesEventToItemOperations,
  type RuntimeItemOperation,
} from './runtime-items.js';

export class ResponsesProtocol implements StreamProtocol {
  readonly id = 'responses';

  createState(): Record<string, unknown> {
    return createResponsesStreamState() as Record<string, unknown>;
  }

  /**
   * Identity-aware item operations for one transport event, keyed by the
   * Responses output item id. This is the schema-v2 path; `parse` remains the
   * legacy action projection for the existing dispatcher.
   */
  parseItemOperations(
    event: TransportEvent,
    runId: string,
    scopeId: string,
  ): RuntimeItemOperation[] {
    return responsesEventToItemOperations(event.eventName, event.data as Record<string, unknown>, runId, scopeId);
  }

  parse(event: TransportEvent, state: Record<string, unknown>): StreamAction[] {
    const actions = normalizeResponsesStreamEvent({
      eventName: event.eventName,
      data: event.data,
      state: state as ReturnType<typeof createResponsesStreamState>,
    });

    return actions.map((action) => {
      if (action.type === 'tool_upsert') {
        const { approvalRequestId, previousResponseId, serverLabel, ...rest } = action as typeof action & {
          approvalRequestId?: string;
          previousResponseId?: string;
          serverLabel?: string;
        };
        return {
          ...rest,
          extra: {
            ...(approvalRequestId ? { approvalRequestId } : {}),
            ...(previousResponseId ? { previousResponseId } : {}),
            ...(serverLabel ? { serverLabel } : {}),
            ...(approvalRequestId ? { approvalProtocol: 'responses' } : {}),
          },
        } as StreamAction;
      }
      return action as StreamAction;
    });
  }
}
