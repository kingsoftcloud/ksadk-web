import type { JsonValue } from '../../types/json-value.js';
/**
 * Headless InteractionClient implementation.
 *
 * One submit path per record source:
 * - `interaction_v1` (AgentEngine Interaction/v1): every action is one
 *   `POST /agentengine/api/v1/SubmitInteraction` call with revision CAS
 *   and an idempotency key.
 * - `responses`: official `/v1/responses` `mcp_approval_response` path
 *   (0.3.1 fallback for servers without `interaction_v1`).
 * - `agui`: `resumeAguiInterrupt` (0.3.1 fallback).
 *
 * Components never branch on the source — they call `respond()`.
 */
import {
  interactionIdempotencyKey,
  isTerminalInteraction,
  summarizeResponse,
  type Interaction,
  type InteractionAction,
  type InteractionClient,
  type InteractionEvent,
  type InteractionOutcome,
  type InteractionReceipt,
  type InteractionSubmitInput,
} from './types.js';
import { InteractionStore } from './store.js';
import { decodeReceipt } from '../../types/agent-control.js';
import { jsonValue } from '../../types/json-value.js';
import { validateInput } from './schema.js';

export type SubmitInteractionTransport = (params: {
  AgentId: string;
  SessionId: string;
  RunId: string;
  InteractionId: string;
  ExpectedRevision: number;
  Action: InteractionAction;
  Response: JsonValue;
  IdempotencyKey: string;
}) => Promise<unknown>;

export type InteractionClientDeps = {
  agentId: string;
  store?: InteractionStore;
  submitInteraction: SubmitInteractionTransport;
  /**
   * When bootstrap advertises `interaction_v1`, every action goes through
   * SubmitInteraction regardless of the transport that produced the
   * pending record.
   */
  interactionV1Enabled?: boolean;
  /** @deprecated 0.3.1 Responses `mcp_approval_response` fallback. */
  legacyResponsesApproval?: (
    interactionId: string,
    approve: boolean,
    previousResponseId?: string,
  ) => boolean | void | Promise<boolean | void>;
  /** @deprecated 0.3.1 AG-UI `resumeAguiInterrupt` fallback. */
  legacyAguiResume?: (
    interruptId: string,
    status: 'resolved' | 'cancelled',
    payload?: unknown,
  ) => boolean;
};

const ACTION_OUTCOME: Record<InteractionAction, InteractionOutcome> = {
  approve: 'approved',
  reject: 'rejected',
  submit: 'submitted',
  cancel: 'cancelled',
};

function syntheticReceipt(
  status: InteractionReceipt['status'],
  interactionId: string,
): InteractionReceipt {
  return {
    schema_version: 1,
    command_id: `local-${interactionId}`,
    status,
    message_id: null,
    run_id: null,
    accepted_seq: null,
    error: null,
    extensions: {},
  };
}

export class InteractionClientImpl implements InteractionClient {
  readonly store: InteractionStore;
  private deps: InteractionClientDeps;
  /** Session-scoped interaction key -> in-flight idempotency key. */
  private inFlight = new Map<string, string>();

  constructor(deps: InteractionClientDeps) {
    this.deps = deps;
    this.store = deps.store || new InteractionStore();
  }

  listPending(sessionId: string): readonly Interaction[] {
    return this.store.listPending(sessionId);
  }

  /** Update capability routing after bootstrap capabilities change. */
  setInteractionV1Enabled(enabled: boolean): void {
    this.deps.interactionV1Enabled = enabled;
  }

  subscribe(listener: (event: InteractionEvent) => void): () => void {
    return this.store.subscribe(listener);
  }

  /** Normalize + persist an incoming Interaction (adapter output). */
  ingest(interaction: Interaction): void {
    this.store.upsert(interaction);
  }

  /**
   * Restore state from replayed history. Only upserts server facts —
   * never issues a submit — so a refresh/replay restores a pending
   * Interaction without creating a second request.
   */
  ingestHistory(interactions: readonly Interaction[]): void {
    for (const interaction of interactions) {
      this.store.upsert(interaction);
    }
    // Any in-flight submit whose interaction is now terminal server-side
    // (another tab won first) is dropped.
    for (const [key] of this.inFlight) {
      const record = this.store.all().find(record => this.recordKey(record) === key);
      if (record && record.status !== 'pending' && record.status !== 'resolving') {
        this.inFlight.delete(key);
      }
    }
  }

  private recordKey(record: Interaction): string {
    return JSON.stringify([record.sessionId, record.interactionId]);
  }

  private findByInteractionId(interactionId: string, sessionId?: string): Interaction | null {
    if (sessionId) return this.store.get(sessionId, interactionId);
    const matches = this.store.all().filter(record => record.interactionId === interactionId);
    return matches.length === 1 ? matches[0] : null;
  }

  async respond(input: InteractionSubmitInput): Promise<InteractionReceipt> {
    const record = this.findByInteractionId(input.interactionId, input.sessionId);
    if (!record) {
      return syntheticReceipt('rejected', input.interactionId);
    }

    // Terminal (resolved by an authoritative SessionEvent): no second
    // request leaves the client. `resolving` and `failed` stay
    // submittable — a receipt is never a terminal fact.
    if (record.status === 'resolved' || record.status === 'cancelled' || record.status === 'expired') {
      return syntheticReceipt('duplicate', input.interactionId);
    }

    // A previous submit's receipt was accepted but its terminal
    // SessionEvent has not arrived yet: treat as duplicate rather than
    // issuing a competing second decision.
    if (record.status === 'resolving') {
      return syntheticReceipt('duplicate', input.interactionId);
    }

    try {
      jsonValue(input.response);
    } catch {
      this.store.markFailed(record.sessionId, input.interactionId, {
        code: 'input_response_invalid', message: '答案必须是合法 JSON 值。', retryable: true,
      });
      return syntheticReceipt('rejected', input.interactionId);
    }
    if (record.kind === 'structured_input' && input.action === 'submit' && record.requestSchema) {
      const validation = validateInput(record.requestSchema, input.response);
      if (!validation.valid) {
        this.store.markFailed(record.sessionId, input.interactionId, {
          code: 'input_response_invalid', message: validation.issues.join('；'), retryable: true,
        });
        return syntheticReceipt('rejected', input.interactionId);
      }
    }
    if (record.source === 'agui' && !this.deps.interactionV1Enabled
      && input.action !== 'cancel' && input.response === null) {
      this.store.markFailed(record.sessionId, input.interactionId, {
        code: 'input_transport_unsupported',
        message: '当前 AG-UI 传输不能提交根 null，请使用 Interaction/v1。', retryable: false,
      });
      return syntheticReceipt('rejected', input.interactionId);
    }

    const baseKey = input.idempotencyKey
      || interactionIdempotencyKey(input.interactionId, input.expectedRevision);
    // A definitively rejected Inbox command cannot be retried under its old key.
    // Transport uncertainty still reuses the same key.
    const rejectedCommand = record.extensions.rejected_command_id;
    const idempotencyKey = rejectedCommand ? `${baseKey}:retry-${rejectedCommand}` : baseKey;

    // Double-click / concurrent submit guard: same idempotency key in
    // flight means this exact submit already happened.
    const recordKey = this.recordKey(record);
    const inFlightKey = this.inFlight.get(recordKey);
    if (inFlightKey) {
      if (inFlightKey === idempotencyKey) {
        return syntheticReceipt('duplicate', input.interactionId);
      }
      return syntheticReceipt('rejected', input.interactionId);
    }

    this.inFlight.set(recordKey, idempotencyKey);
    this.store.markResolving(record.sessionId, input.interactionId);

    const useInteractionV1 =
      this.deps.interactionV1Enabled || record.source === 'interaction_v1';

    try {
      if (!useInteractionV1 && record.source === 'responses' && this.deps.legacyResponsesApproval) {
        const previousResponseId = record.extensions.previous_response_id;
        const dispatched = await this.deps.legacyResponsesApproval(
          input.interactionId,
          input.action === 'approve',
          ...(typeof previousResponseId === 'string' && previousResponseId
            ? [previousResponseId] as const : []),
        );
        if (dispatched === false) {
          this.store.markFailed(record.sessionId, input.interactionId, {
            code: 'interaction_not_dispatched',
            message: '交互尚未提交，请稍后重试。',
            retryable: true,
          });
          return syntheticReceipt('rejected', input.interactionId);
        }
        this.resolveLocal(record, input, idempotencyKey);
        return syntheticReceipt('accepted', input.interactionId);
      }

      if (!useInteractionV1 && record.source === 'agui' && this.deps.legacyAguiResume) {
        const accepted = this.deps.legacyAguiResume(
          String(record.extensions.interrupt_id || input.interactionId),
          input.action === 'cancel' ? 'cancelled' : 'resolved',
          input.response,
        );
        if (!accepted) {
          this.store.revertToPending(record.sessionId, input.interactionId);
          return syntheticReceipt('rejected', input.interactionId);
        }
        // Dispatch is not native consumption. The resume stream confirms
        // completion, the next wait, or a correctable validation rejection.
        this.store.recordIdempotencyKey(record.sessionId, input.interactionId, idempotencyKey);
        return syntheticReceipt('accepted', input.interactionId);
      }

      const raw = await this.deps.submitInteraction({
        AgentId: this.deps.agentId,
        SessionId: record.sessionId,
        RunId: record.runId || '',
        InteractionId: input.interactionId,
        ExpectedRevision: input.expectedRevision,
        Action: input.action,
        Response: input.response,
        IdempotencyKey: idempotencyKey,
      });
      const receipt = decodeReceipt(raw);

      if (receipt.status === 'accepted' || receipt.status === 'duplicate') {
        // The receipt only proves the command entered the durable Inbox —
        // it is NOT a terminal fact. Keep `resolving` until the
        // authoritative interaction.resolved/cancelled/expired
        // SessionEvent arrives via the dispatcher or replay. Record the
        // idempotency key for replay correlation.
        this.store.recordCommand(record.sessionId, input.interactionId, receipt.command_id);
        this.store.recordIdempotencyKey(
          record.sessionId,
          input.interactionId,
          idempotencyKey,
        );
      } else if (receipt.status === 'queue_full') {
        // Transient: back to pending so the user can retry.
        this.store.revertToPending(record.sessionId, input.interactionId);
      } else {
        // Definitive rejection (e.g. interaction_already_resolved from a
        // first-wins other tab), unsupported, or uncertain: surface the
        // failure. The SessionEvent stream remains the only source of a
        // terminal state.
        this.store.markFailed(record.sessionId, input.interactionId, {
          code: receipt.error?.code ?? String(receipt.status),
          message: receipt.error?.message ?? `提交未通过（${receipt.status}）`,
          retryable: receipt.error?.retryable ?? false,
        });
      }
      return receipt;
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : String(error || '交互提交失败');
      this.store.markFailed(record.sessionId, input.interactionId, {
        code: 'interaction_submit_failed',
        message,
        retryable: true,
      });
      throw error;
    } finally {
      this.inFlight.delete(recordKey);
    }
  }

  private resolveLocal(
    record: Interaction,
    input: InteractionSubmitInput,
    idempotencyKey: string,
  ): void {
    // An authoritative terminal event may arrive while an asynchronous legacy
    // callback is completing. Preserve that server fact rather than replacing
    // it with this callback's optimistic decision.
    const current = this.store.get(record.sessionId, input.interactionId);
    if (!current || isTerminalInteraction(current.status)) return;
    const terminalStatus =
      input.action === 'cancel' ? 'cancelled' : 'resolved';
    this.store.resolveLocally(record.sessionId, input.interactionId, {
      status: terminalStatus,
      outcome: ACTION_OUTCOME[input.action],
      actor: 'user',
      responseSummary: record.kind === 'structured_input'
        ? input.action === 'cancel' ? '已取消' : '已提交'
        : summarizeResponse(input.action, input.response),
      revision: input.expectedRevision,
    });
    // Keep the idempotency key recorded for replay correlation.
    const updated = this.store.get(record.sessionId, input.interactionId);
    if (updated) {
      this.store.upsert({
        ...updated,
        extensions: { ...updated.extensions, idempotency_key: idempotencyKey },
      });
    }
  }
}
