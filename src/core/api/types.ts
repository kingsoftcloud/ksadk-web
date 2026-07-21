export interface ApiFacade {
  // Session
  listSessions(agentId: string, opts?: { page?: number; pageSize?: number; signal?: AbortSignal }): Promise<{
    Sessions: unknown[];
    Total?: number;
    Page?: number;
    PageSize?: number;
  }>;
  createSession(agentId: string, opts?: { signal?: AbortSignal }): Promise<{ SessionId: string }>;
  deleteSession(sessionId: string, opts?: { signal?: AbortSignal }): Promise<void>;
  getSession(sessionId: string, opts?: { signal?: AbortSignal }): Promise<{
    SessionId: string;
    AgentId?: string;
    Title?: string;
    UpdatedAt?: string;
    ActiveRunStatus?: string;
    ActiveInvocationId?: string;
    ActiveRunUpdatedAt?: string;
    ContextUsage?: { used_tokens: number; cached_tokens?: number; context_window_tokens: number; percent: number } | null;
    TokenUsage?: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      turns?: number;
      last_response_id?: string;
    } | null;
  }>;

  // Events & Run
  listSessionEvents(sessionId: string, opts?: { offset?: number; limit?: number; signal?: AbortSignal }): Promise<{
    Events: unknown[];
    Total?: number;
    Offset?: number;
    Limit?: number;
  }>;
  listSessionMessages(
    sessionId: string,
    opts?: {
      agentId?: string;
      afterSeqId?: number;
      beforeSeqId?: number;
      limit?: number;
      includeReasoning?: boolean;
      includeToolEvents?: boolean;
      includeAttachments?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<{
    Messages: unknown[];
    LatestSeqId: number;
    HasMore: boolean;
    NextCursor: number | null;
  }>;
  listSessionCheckpoints(params: { agentId: string; sessionId: string; runId?: string }, opts?: { signal?: AbortSignal }): Promise<{ Checkpoints: unknown[] }>;
  listToolReceipts(params: { agentId: string; sessionId: string; runId?: string; checkpointId?: string }, opts?: { signal?: AbortSignal }): Promise<{ ToolReceipts: unknown[] }>;
  previewCheckpointResume(params: { agentId: string; sessionId: string; runId: string; checkpointId: string }, opts?: { signal?: AbortSignal }): Promise<{ Preview: unknown }>;
  runAgent(body: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>>;
  resumeRun(params: { agentId: string; sessionId: string; runId: string; checkpointId: string; resumeAttemptId?: string; invocationId?: string }, opts?: { signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>>;
  subscribeRunEvents(params: { sessionId: string; invocationId: string; afterSeqId: number }, opts?: { signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>>;
  cancelRun(agentId: string, sessionId: string, invocationId: string, opts?: { signal?: AbortSignal }): Promise<unknown>;

  // Feedback
  getResponseFeedback(payload: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<unknown>;
  upsertResponseFeedback(payload: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<unknown>;
  deleteResponseFeedback(payload: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<void>;

  // Workspace
  listWorkspaceFiles(agentId: string, path: string, recursive: boolean, opts?: { signal?: AbortSignal }): Promise<unknown>;
  addWorkspaceFile(formData: FormData, opts?: { signal?: AbortSignal }): Promise<unknown>;
  deleteWorkspaceFile(agentId: string, path: string, opts?: { signal?: AbortSignal }): Promise<void>;
  getWorkspaceFileContent(agentId: string, path: string, opts?: { signal?: AbortSignal; asText?: boolean }): Promise<Blob | string>;

  // Models & Bootstrap
  listAgentModels(agentId: string, opts?: { signal?: AbortSignal }): Promise<unknown>;
  getAgentUiBootstrap(opts?: { signal?: AbortSignal }): Promise<unknown>;

  // Upload
  uploadFile(formData: FormData, opts?: { signal?: AbortSignal }): Promise<{ FileData: { fileUri: string; displayName: string; mimeType: string } }>;
}
