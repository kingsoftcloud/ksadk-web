export type SessionEventRecord = {
  EventId?: string;
  EventType?: string;
  // Backend returns the owning session id on each event record; dispatcher
  // falls back to it when the wrapping RunEvent has no sessionId.
  SessionId?: string;
  InvocationId?: string;
  Content?: {
    role?: string;
    status?: string;
    detail?: string;
    phase?: string | null;
    payload?: Record<string, unknown> & {
      status?: string;
      detail?: string;
      text?: string;
      call_id?: string;
      name?: string;
      args?: unknown;
      result?: unknown;
      error?: unknown;
    };
    parts?: Array<{
      type?: string;
      text?: string;
      functionCall?: {
        name?: string;
        args?: unknown;
      };
      functionResponse?: {
        name?: string;
        response?: unknown;
      };
      inlineData?: {
        displayName?: string;
        mimeType?: string;
        data?: string;
      };
      fileData?: {
        fileUri?: string;
        displayName?: string;
        mimeType?: string;
      };
    }>;
  };
  Timestamp?: number;
  Metadata?: Record<string, unknown> & {
    response_id?: string;
    ResponseId?: string;
    trace_id?: string;
    TraceId?: string;
    root_span_id?: string;
    rootSpanId?: string;
    RootSpanId?: string;
    responses_output?: unknown;
  };
  SeqId?: number;
};

export type CompactionStreamPayload = {
  phase?: 'start' | 'done' | 'failed';
  trigger?: 'auto' | 'prompt_too_long';
  compacted_until_seq_id?: number;
  timestamp?: number;
};
