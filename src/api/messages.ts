import { postJsonAction } from './client.js';

export type BackendMessage = {
  MessageId?: string;
  Role: 'user' | 'assistant' | 'tool' | 'system';
  Content?: { text?: string } | unknown;
  Reasoning?: { text: string; SeqId: number }[];
  ToolEvents?: {
    SeqId?: number;
    Type?: string;
    Name: string;
    Args?: unknown;
    Result?: unknown;
    Status?: 'running' | 'completed' | 'failed' | 'paused' | 'approved' | 'denied';
    ToolCallId?: string;
    ApprovalRequestId?: string;
    ResultSeqId?: number;
    Reason?: string;
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
};

export type ListSessionMessagesOptions = {
  agentId?: string;
  afterSeqId?: number;
  beforeSeqId?: number;
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
};

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
      Limit: opts?.limit,
      IncludeReasoning: opts?.includeReasoning,
      IncludeToolEvents: opts?.includeToolEvents,
      IncludeAttachments: opts?.includeAttachments,
    },
    opts,
  );
  return {
    Messages: data.Messages ?? [],
    LatestSeqId: Number.isFinite(Number(data.LatestSeqId)) ? Number(data.LatestSeqId) : 0,
    HasMore: Boolean(data.HasMore),
    NextCursor: data.NextCursor === null || data.NextCursor === undefined
      ? null
      : Number.isFinite(Number(data.NextCursor))
        ? Number(data.NextCursor)
        : null,
  };
}
