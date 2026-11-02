import { postJsonAction } from './client.js';

export type BackendMessage = {
  MessageId?: string;
  Role: 'user' | 'assistant' | 'tool' | 'system';
  Content?: { text?: string } | unknown;
  Reasoning?: { text: string; SeqId: number }[];
  /** Ordered persisted stream timeline for lossless history replay. */
  Blocks?: {
    Type: 'thinking' | 'text' | 'tool';
    SeqId?: number;
    Content?: string;
    Name?: string;
    Args?: unknown;
    Result?: unknown;
    Status?: 'running' | 'completed' | 'failed' | 'paused' | 'unknown';
    ToolCallId?: string;
  }[];
  ToolEvents?: {
    SeqId?: number;
    Type?: string;
    Name: string;
    Args?: unknown;
    Result?: unknown;
    Status?: 'running' | 'completed' | 'failed' | 'paused' | 'unknown' | 'approved' | 'denied' | 'rejected' | 'cancelled' | 'expired';
    ToolCallId?: string;
    ApprovalRequestId?: string;
    ApprovalStatus?: 'pending' | 'paused' | 'approved' | 'denied' | 'rejected' | 'cancelled' | 'expired';
    Protocol?: string;
    ApprovalLevel?: string;
    ApprovalMessage?: string;
    ResultSeqId?: number;
    Reason?: string;
  }[];
  Activities?: {
    SeqId?: number;
    Type?: string;
    MessageId?: string;
    SurfaceId?: string;
    Content?: unknown;
  }[];
  Attachments?: {
    file_uri: string;
    name: string;
    mime: string;
    size: number;
    url: string;
    is_image: boolean;
  }[];
  Timestamp?: string;
  SeqId?: number;
  InvocationId?: string;
  ScopeId?: string;
  ResponseId?: string;
};

export type ListSessionMessagesOptions = {
  agentId?: string;
  afterSeqId?: number;
  beforeSeqId?: number;
  cursorSource?: string;
  historyEpoch?: string;
  snapshotSeqId?: number;
  limit?: number;
  includeReasoning?: boolean;
  includeToolEvents?: boolean;
  includeAttachments?: boolean;
  signal?: AbortSignal;
};

export type ListSessionMessagesResponse = {
  Messages: BackendMessage[];
  LatestSeqId: number;
  HasMore: boolean;
  NextCursor: number | null;
  DataSource?: string;
  Degraded?: boolean;
  CursorSource?: string;
  CursorCompatibleWithRuntime?: boolean;
  SessionContractVersion?: number;
  HistoryEpoch?: string;
  PersistenceDegraded?: boolean;
  SnapshotSeqId?: number;
};

/** Preserve the history contract through both hosted and embedded API entries. */
export function normalizeSessionMessagesResponse(data: ListSessionMessagesResponse): ListSessionMessagesResponse {
  const optionalSeq = (value: unknown) => value !== null && value !== undefined
    && Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : undefined;
  return {
    Messages: data.Messages ?? [],
    LatestSeqId: Number.isFinite(Number(data.LatestSeqId)) ? Number(data.LatestSeqId) : 0,
    HasMore: Boolean(data.HasMore),
    NextCursor: data.NextCursor === null || data.NextCursor === undefined
      ? null : Number.isFinite(Number(data.NextCursor)) ? Number(data.NextCursor) : null,
    DataSource: data.DataSource,
    Degraded: data.Degraded,
    CursorSource: data.CursorSource,
    CursorCompatibleWithRuntime: data.CursorCompatibleWithRuntime,
    SessionContractVersion: data.SessionContractVersion,
    HistoryEpoch: data.HistoryEpoch,
    PersistenceDegraded: data.PersistenceDegraded,
    SnapshotSeqId: optionalSeq(data.SnapshotSeqId),
  };
}

export async function listSessionMessages(
  sessionId: string,
  opts?: ListSessionMessagesOptions,
): Promise<ListSessionMessagesResponse> {
  const data = await postJsonAction<ListSessionMessagesResponse>(
    'ListSessionMessages',
    {
      AgentId: opts?.agentId,
      SessionId: sessionId,
      AfterSeqId: opts?.afterSeqId,
      BeforeSeqId: opts?.beforeSeqId,
      CursorSource: opts?.cursorSource,
      HistoryEpoch: opts?.historyEpoch,
      SnapshotSeqId: opts?.snapshotSeqId,
      Limit: opts?.limit,
      IncludeReasoning: opts?.includeReasoning,
      IncludeToolEvents: opts?.includeToolEvents,
      IncludeAttachments: opts?.includeAttachments,
    },
    opts,
  );
  return normalizeSessionMessagesResponse(data);
}
