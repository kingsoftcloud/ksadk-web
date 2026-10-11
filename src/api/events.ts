import { postJsonAction } from './client.js';

export type ListSessionEventsOptions = {
  offset?: number;
  limit?: number;
  cursorSource?: string;
  historyEpoch?: string;
  snapshotSeqId?: number;
  signal?: AbortSignal;
};

export type ListSessionEventsResponse = {
  Events: unknown[];
  Total?: number;
  Offset?: number;
  Limit?: number;
  DataSource?: string;
  Degraded?: boolean;
  CursorSource?: string;
  CursorCompatibleWithRuntime?: boolean;
  SessionContractVersion?: number;
  HistoryEpoch?: string;
  PersistenceDegraded?: boolean;
  SnapshotSeqId?: number;
};

export async function listSessionEvents(
  sessionId: string,
  opts?: ListSessionEventsOptions,
): Promise<ListSessionEventsResponse> {
  const data = await postJsonAction<ListSessionEventsResponse>('ListSessionEvents', {
    SessionId: sessionId,
    Offset: opts?.offset,
    Limit: opts?.limit,
    CursorSource: opts?.cursorSource,
    HistoryEpoch: opts?.historyEpoch,
    SnapshotSeqId: opts?.snapshotSeqId,
  }, opts);
  return {
    Events: data.Events ?? [],
    Total: Number.isFinite(Number(data.Total)) ? Number(data.Total) : data.Events?.length ?? 0,
    Offset: Number.isFinite(Number(data.Offset)) ? Number(data.Offset) : opts?.offset ?? 0,
    Limit: Number.isFinite(Number(data.Limit)) ? Number(data.Limit) : opts?.limit ?? data.Events?.length ?? 0,
    DataSource: data.DataSource,
    Degraded: data.Degraded,
    CursorSource: data.CursorSource,
    CursorCompatibleWithRuntime: data.CursorCompatibleWithRuntime,
    SessionContractVersion: data.SessionContractVersion,
    HistoryEpoch: data.HistoryEpoch,
    PersistenceDegraded: data.PersistenceDegraded,
    SnapshotSeqId: data.SnapshotSeqId,
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
