import { streamAction, postJsonAction } from './client.js';
import { decodeReceipt, type AgentControlReceipt } from '../types/agent-control.js';

export async function runAgent(
  body: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<ReadableStream<Uint8Array>> {
  return streamAction('RunAgent', body, options);
}

export type SubmitAgentControlParams = {
  commandType: 'enqueue' | 'steer' | 'inject' | 'interrupt' | 'pause' | 'resume' | 'submit_interaction';
  idempotencyKey: string;
  payload: Record<string, unknown>;
};

/**
 * Submit an agent-kernel/v1 AgentControlCommand and decode the receipt with
 * the canonical strict decoder; malformed receipts throw
 * ContractMismatchError.
 */
export async function submitAgentControl(
  params: SubmitAgentControlParams,
  options?: { signal?: AbortSignal },
): Promise<AgentControlReceipt> {
  const data = await postJsonAction<unknown>('SubmitAgentControl', {
    CommandType: params.commandType,
    IdempotencyKey: params.idempotencyKey,
    Payload: params.payload,
  }, options);
  return decodeReceipt(data);
}

export type SubmitInteractionParams = {
  AgentId: string;
  SessionId: string;
  RunId: string;
  InteractionId: string;
  ExpectedRevision: number;
  Action: 'approve' | 'reject' | 'submit' | 'cancel';
  Response: Record<string, unknown>;
  IdempotencyKey: string;
};

/**
 * AgentEngine Interaction/v1 submission. One public action, revision CAS,
 * idempotency-scoped; the receipt is decoded with the canonical strict
 * decoder.
 */
export async function submitInteraction(
  params: SubmitInteractionParams,
  options?: { signal?: AbortSignal },
): Promise<AgentControlReceipt> {
  const data = await postJsonAction<unknown>('SubmitInteraction', { ...params }, options);
  return decodeReceipt(data);
}
