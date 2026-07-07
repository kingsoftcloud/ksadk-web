import { postJsonAction } from './client.js';

type SessionPayload = {
  SessionId: string;
  AgentId: string;
  UserId: string;
  Title?: string;
  Summary?: string;
  FirstPrompt?: string;
  LastPrompt?: string;
  UpdatedAt?: string;
  CreatedAt?: string;
  ActiveRunStatus?: string;
  ActiveInvocationId?: string;
  ActiveRunMode?: string;
  ActiveRunTrigger?: string;
  ActiveRunUpdatedAt?: string;
  ContextUsage?: { used_tokens: number; cached_tokens?: number; context_window_tokens: number; percent: number } | null;
  TokenUsage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    turns?: number;
    last_response_id?: string;
  } | null;
};

type ListSessionsResponse = {
  Sessions: SessionPayload[];
  Total?: number;
  Page?: number;
  PageSize?: number;
};

type CreateSessionResponse = {
  Session: SessionPayload;
};

export type { SessionPayload };

export type ListSessionsOptions = {
  page?: number;
  pageSize?: number;
  signal?: AbortSignal;
};

export async function listSessions(
  agentId: string,
  opts?: ListSessionsOptions,
): Promise<ListSessionsResponse> {
  const data = await postJsonAction<ListSessionsResponse>('ListSessions', {
    AgentId: agentId,
    Page: opts?.page,
    PageSize: opts?.pageSize,
  }, opts);
  return {
    Sessions: data.Sessions ?? [],
    Total: Number.isFinite(Number(data.Total)) ? Number(data.Total) : data.Sessions?.length ?? 0,
    Page: Number.isFinite(Number(data.Page)) ? Number(data.Page) : opts?.page ?? 1,
    PageSize: Number.isFinite(Number(data.PageSize))
      ? Number(data.PageSize)
      : opts?.pageSize ?? data.Sessions?.length ?? 0,
  };
}

export async function createSession(agentId: string, opts?: { signal?: AbortSignal }): Promise<SessionPayload> {
  const data = await postJsonAction<CreateSessionResponse>('CreateSession', {
    AgentId: agentId,
  }, opts);
  return data.Session;
}

export async function deleteSession(sessionId: string, opts?: { signal?: AbortSignal }): Promise<void> {
  await postJsonAction<unknown>('DeleteSession', { SessionId: sessionId }, opts);
}

export async function getSession(
  sessionId: string,
  opts?: { signal?: AbortSignal },
): Promise<SessionPayload> {
  return postJsonAction<SessionPayload>('GetSession', { SessionId: sessionId }, opts);
}
