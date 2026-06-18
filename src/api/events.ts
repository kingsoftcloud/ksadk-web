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
