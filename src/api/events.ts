import { postJsonAction } from './client.js';

export type ListSessionEventsOptions = {
  offset?: number;
  limit?: number;
  signal?: AbortSignal;
};

export type ListSessionEventsResponse = {
  Events: unknown[];
  Total?: number;
  Offset?: number;
  Limit?: number;
};

export async function listSessionEvents(
  sessionId: string,
  opts?: ListSessionEventsOptions,
): Promise<ListSessionEventsResponse> {
  const data = await postJsonAction<ListSessionEventsResponse>('ListSessionEvents', {
    SessionId: sessionId,
    Offset: opts?.offset,
    Limit: opts?.limit,
  }, opts);
  return {
    Events: data.Events ?? [],
    Total: Number.isFinite(Number(data.Total)) ? Number(data.Total) : data.Events?.length ?? 0,
    Offset: Number.isFinite(Number(data.Offset)) ? Number(data.Offset) : opts?.offset ?? 0,
    Limit: Number.isFinite(Number(data.Limit)) ? Number(data.Limit) : opts?.limit ?? data.Events?.length ?? 0,
  };
}

import { streamGetAction } from './client.js';

/**
 * agent-kernel/v1 session event subscription. `afterSeq` is the unified
 * Session seq cursor; reconnects resume from the last observed seq.
 */
export async function subscribeSessionEvents(
  sessionId: string,
  afterSeq: number,
  options?: { signal?: AbortSignal },
): Promise<ReadableStream<Uint8Array>> {
  return streamGetAction(
    'SubscribeSessionEvents',
    { SessionId: sessionId, after_seq: String(afterSeq) },
    options,
  );
}
