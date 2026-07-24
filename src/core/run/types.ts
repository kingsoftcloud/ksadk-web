import type { RuntimeApiFormat } from '../../types/api.js';
import type { HostedChatTransport } from '../../types/api.js';
import type { ModelCatalogItem } from '../../components/chat/types.js';

export type RunStage =
  | 'idle' | 'creating-session' | 'uploading-files'
  | 'connecting' | 'streaming' | 'stopping'
  | 'completing' | 'recovering' | 'error'
  | 'cancelled';

export type RunEvent =
  | { type: 'stage_changed'; stage: RunStage; sessionId?: string | null }
  | {
      type: 'activity';
      sessionId?: string | null;
      phase: string;
      source?: 'run' | 'restore';
      status?: 'connecting' | 'running' | 'waiting' | 'stopped' | 'completed' | 'failed';
      detail?: string;
      countEvent?: boolean;
    }
  | { type: 'user_message_added'; messageId: string; sessionId?: string | null }
  | { type: 'assistant_message_created'; messageId: string; sessionId?: string | null }
  | { type: 'text_delta'; messageId: string; delta: string; sessionId?: string | null }
  | { type: 'text_final'; messageId: string; text: string; sessionId?: string | null }
  | { type: 'reasoning_delta'; messageId: string; delta: string; sessionId?: string | null }
  | { type: 'tool_upsert'; messageId: string; name: string; args: string; status: string; extra?: Record<string, unknown>; sessionId?: string | null }
  | { type: 'tool_result'; messageId: string; name: string; output: string; sessionId?: string | null }
  | {
      type: 'approval_requested';
      messageId: string;
      approvalRequestId: string;
      protocol: 'ag-ui' | 'responses';
      name: string;
      args: string;
      message?: string;
      approvalLevel?: string;
      sessionId?: string | null;
    }
  | {
      type: 'approval_resolved';
      approvalRequestId: string;
      decision: 'approved' | 'rejected';
      sessionId?: string | null;
    }
  | { type: 'compaction'; phase: string; trigger?: string; compactedUntilSeqId?: number; sessionId?: string | null }
  | { type: 'system_message'; content: string; sessionId?: string | null }
  | { type: 'stream_ended'; sessionId?: string | null }
  | { type: 'error'; error: Error; sessionId?: string | null }
  | { type: 'terminal'; status: string; sessionId?: string | null }
  | { type: 'stream_event'; event: import('../../types/session-events.js').SessionEventRecord; sessionId?: string | null }
  | { type: 'a2ui_surface_begin'; surfaceId: string; surface: import('../stream/types.js').A2UISurface; sessionId?: string | null }
  | { type: 'a2ui_surface_update'; surfaceId: string; surface: import('../stream/types.js').A2UISurface; sessionId?: string | null }
  | { type: 'a2ui_surface_end'; surfaceId: string; sessionId?: string | null }
  | { type: 'a2ui_interaction'; surfaceId: string; interactionId: string; kind: string; inputSchema: Record<string, unknown>; sessionId?: string | null }
  | {
      type: 'agui_activity';
      messageId: string;
      surfaceId: string;
      messages: Array<Record<string, unknown>>;
      sessionId?: string | null;
    };

export type RunEngineConfig = {
  agentId: string;
  apiFormats: RuntimeApiFormat[];
  agentFramework: string;
  selectedModel: string;
  selectedModelMetadata?: ModelCatalogItem | null;
  thinkingMode: string;
  hostedChatTransport?: HostedChatTransport;
  checkpointResumePreviewEnabled?: boolean;
};

export interface RunEngine {
  updateConfig(config: RunEngineConfig): void;
  start(draft: {
    text: string;
    attachments: File[];
    responsesInput?: unknown;
    previousResponseId?: string;
    sessionId?: string | null;
    onSessionCreated?: (sessionId: string) => void;
    onSessionUpsert?: (sessionId: string) => void;
    onSettled?: (sessionId: string | null) => void;
  }): boolean;
  disconnect(): void;
  stop(): void;
  cancelRemote(invocationId: string): Promise<void>;
  resumeRun(params: {
    sessionId: string;
    invocationId: string;
    afterSeqId: number;
    onSessionReloadNeeded?: () => void;
  }): void;
  resumeCheckpoint(params: {
    sessionId: string;
    runId: string;
    checkpointId: string;
    resumeAttemptId?: string;
    onSettled?: (sessionId: string | null) => void;
  }): boolean;
  resumeAguiInterrupt(params: {
    sessionId?: string | null;
    interruptId: string;
    status: 'resolved' | 'cancelled';
    payload?: unknown;
    onSettled?: (sessionId: string | null) => void;
  }): boolean;
  readonly stage: RunStage;
  subscribe(listener: (event: RunEvent) => void): () => void;
}
