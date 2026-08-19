import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  InteractionClientImpl,
  sharedInteractionStore,
} from '../core/interaction/index.js';
import type {
  Interaction,
  InteractionAction,
  InteractionReceipt,
} from '../core/interaction/types.js';
import type { ApiFacade } from '../core/api/types.js';
import { ksadkA2uiCatalog } from '../core/run/a2ui.js';

type UseInteractionsContext = {
  agentId: string;
  /** Read the current agent id at submit time (bootstrap may arrive late). */
  getAgentId?: () => string;
  currentSessionId: string | null;
  api: ApiFacade;
  /**
   * Bootstrap-advertised `interaction_v1`. When absent the client keeps
   * the 0.3.1 Responses/AG-UI fallback callbacks.
   */
  interactionV1Enabled: boolean;
  /** 0.3.1 fallback: official `mcp_approval_response` submission. */
  legacyResponsesApproval?: (approvalRequestId: string, approve: boolean) => void;
  /** 0.3.1 fallback: AG-UI `resumeAguiInterrupt`. */
  legacyAguiResume?: (
    interruptId: string,
    status: 'resolved' | 'cancelled',
    payload?: unknown,
  ) => boolean;
};

export function useInteractions(ctx: UseInteractionsContext) {
  const [client] = useState(
    () =>
      new InteractionClientImpl({
        agentId: ctx.agentId,
        store: sharedInteractionStore,
        submitInteraction: (params) =>
          ctx.api.submitInteraction({
            ...params,
            AgentId: ctx.getAgentId?.() ?? params.AgentId,
          }),
        interactionV1Enabled: ctx.interactionV1Enabled,
        legacyResponsesApproval: ctx.legacyResponsesApproval,
        legacyAguiResume: ctx.legacyAguiResume,
      }),
  );

  // Keep capability routing current (capability can change after bootstrap).
  useEffect(() => {
    client.setInteractionV1Enabled(ctx.interactionV1Enabled);
  }, [client, ctx.interactionV1Enabled]);

  const [version, setVersion] = useState(0);
  useEffect(() => {
    return sharedInteractionStore.subscribe(() => setVersion((v) => v + 1));
  }, []);

  const pending = useMemo<readonly Interaction[]>(() => {
    void version;
    return ctx.currentSessionId
      ? sharedInteractionStore
          .listAll(ctx.currentSessionId)
          .filter(
            (interaction) =>
              interaction.status === 'pending'
              || interaction.status === 'resolving'
              || interaction.status === 'failed',
          )
      : [];
  }, [version, ctx.currentSessionId]);

  const records = useMemo<readonly Interaction[]>(() => {
    void version;
    return ctx.currentSessionId
      ? sharedInteractionStore.listAll(ctx.currentSessionId)
      : [];
  }, [version, ctx.currentSessionId]);

  const respond = useCallback(
    (input: {
      interactionId: string;
      expectedRevision: number;
      action: InteractionAction;
      response: Record<string, unknown>;
      idempotencyKey: string;
    }): Promise<InteractionReceipt> => client.respond(input),
    [client],
  );

  return {
    client,
    pending,
    records,
    respond,
    localCatalog: ksadkA2uiCatalog,
  };
}
