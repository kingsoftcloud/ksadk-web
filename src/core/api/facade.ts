import type { ApiFacade } from './types.js';
import {
  AgentEngineClient,
  type AgentEngineClientOptions,
} from '../../api/client.js';
import { decodeReceipt } from '../../types/agent-control.js';

type ListSessionsData = {
  Sessions?: unknown[];
  Total?: number;
  Page?: number;
  PageSize?: number;
};

type ListMessagesData = {
  Messages?: unknown[];
  LatestSeqId?: number;
  HasMore?: boolean;
  NextCursor?: number | null;
};

/**
 * Instance-scoped AgentEngine action adapter.
 *
 * Hosted UI uses the zero-argument form. Embedded hosts create one instance
 * with their authenticated fetch and target agent, avoiding global fetch
 * mutation and cookie-based target selection.
 */
export class ApiFacadeImpl implements ApiFacade {
  private readonly client: AgentEngineClient;

  constructor(options: AgentEngineClientOptions = {}) {
    this.client = new AgentEngineClient(options);
  }

  async compactSession(agentId: string, sessionId: string) {
    return this.client.postJsonAction<{ Status: string }>('CompactSession', {
      AgentId: agentId, SessionId: sessionId,
    });
  }

  async listSessions(agentId: string, opts?: { page?: number; pageSize?: number; signal?: AbortSignal }) {
    const data = await this.client.postJsonAction<ListSessionsData>('ListSessions', {
      AgentId: agentId,
      Page: opts?.page,
      PageSize: opts?.pageSize,
    }, opts);
    const sessions = data.Sessions ?? [];
    return {
      Sessions: sessions,
      Total: Number.isFinite(Number(data.Total)) ? Number(data.Total) : sessions.length,
      Page: Number.isFinite(Number(data.Page)) ? Number(data.Page) : opts?.page ?? 1,
      PageSize: Number.isFinite(Number(data.PageSize))
        ? Number(data.PageSize)
        : opts?.pageSize ?? sessions.length,
    };
  }

  async createSession(agentId: string, opts?: { signal?: AbortSignal }) {
    const data = await this.client.postJsonAction<{ Session?: { SessionId?: string } }>(
      'CreateSession',
      { AgentId: agentId },
      opts,
    );
    return { SessionId: String(data.Session?.SessionId || '') };
  }

  async deleteSession(sessionId: string, opts?: { signal?: AbortSignal }) {
    return this.client.postJsonAction<{ Deleted?: boolean; RuntimeSync?: string }>(
      'DeleteSession',
      { SessionId: sessionId },
      opts,
    );
  }

  async getSession(sessionId: string, opts?: { signal?: AbortSignal }) {
    const data = await this.client.postJsonAction<{ Session: Awaited<ReturnType<ApiFacade['getSession']>> }>(
      'GetSession',
      { SessionId: sessionId },
      opts,
    );
    return data.Session;
  }

  async listSessionEvents(sessionId: string, opts?: { offset?: number; limit?: number; signal?: AbortSignal }) {
    const data = await this.client.postJsonAction<{
      Events?: unknown[];
      Total?: number;
      Offset?: number;
      Limit?: number;
    }>('ListSessionEvents', {
      SessionId: sessionId,
      Offset: opts?.offset,
      Limit: opts?.limit,
    }, opts);
    const events = data.Events ?? [];
    return {
      Events: events,
      Total: Number.isFinite(Number(data.Total)) ? Number(data.Total) : events.length,
      Offset: Number.isFinite(Number(data.Offset)) ? Number(data.Offset) : opts?.offset ?? 0,
      Limit: Number.isFinite(Number(data.Limit)) ? Number(data.Limit) : opts?.limit ?? events.length,
    };
  }

  async listSessionMessages(
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
  ) {
    const data = await this.client.postJsonAction<ListMessagesData>('ListSessionMessages', {
      AgentId: opts?.agentId,
      SessionId: sessionId,
      AfterSeqId: opts?.afterSeqId,
      BeforeSeqId: opts?.beforeSeqId,
      Limit: opts?.limit,
      IncludeReasoning: opts?.includeReasoning,
      IncludeToolEvents: opts?.includeToolEvents,
      IncludeAttachments: opts?.includeAttachments,
    }, opts);
    return {
      Messages: data.Messages ?? [],
      LatestSeqId: Number.isFinite(Number(data.LatestSeqId)) ? Number(data.LatestSeqId) : 0,
      HasMore: Boolean(data.HasMore),
      NextCursor: data.NextCursor === null || data.NextCursor === undefined
        ? null
        : Number.isFinite(Number(data.NextCursor)) ? Number(data.NextCursor) : null,
    };
  }

  async listSessionCheckpoints(params: { agentId: string; sessionId: string; runId?: string }, opts?: { signal?: AbortSignal }) {
    return this.client.postJsonAction<{ Checkpoints: unknown[] }>('ListSessionCheckpoints', {
      AgentId: params.agentId,
      SessionId: params.sessionId,
      ...(params.runId ? { RunId: params.runId } : {}),
    }, opts);
  }

  async previewCheckpointResume(params: { agentId: string; sessionId: string; runId: string; checkpointId: string }, opts?: { signal?: AbortSignal }) {
    return this.client.postJsonAction<{ Preview: unknown }>('GetCheckpointResumePreview', {
      AgentId: params.agentId,
      SessionId: params.sessionId,
      RunId: params.runId,
      CheckpointId: params.checkpointId,
    }, opts);
  }

  async listToolReceipts(params: { agentId: string; sessionId: string; runId?: string; checkpointId?: string }, opts?: { signal?: AbortSignal }) {
    return this.client.postJsonAction<{ ToolReceipts: unknown[] }>('ListToolReceipts', {
      AgentId: params.agentId,
      SessionId: params.sessionId,
      ...(params.runId ? { RunId: params.runId } : {}),
      ...(params.checkpointId ? { CheckpointId: params.checkpointId } : {}),
    }, opts);
  }

  async runAgent(body: Record<string, unknown>, opts?: { signal?: AbortSignal }) {
    return this.client.streamAction('RunAgent', body, opts);
  }

  async resumeRun(
    params: { agentId: string; sessionId: string; runId: string; checkpointId: string; resumeAttemptId?: string; invocationId?: string },
    opts?: { signal?: AbortSignal },
  ) {
    return this.client.streamAction('ResumeRun', {
      AgentId: params.agentId,
      SessionId: params.sessionId,
      RunId: params.runId,
      CheckpointId: params.checkpointId,
      Stream: true,
      ...(params.resumeAttemptId ? { ResumeAttemptId: params.resumeAttemptId } : {}),
      ...(params.invocationId ? { InvocationId: params.invocationId } : {}),
    }, opts);
  }

  async subscribeRunEvents(params: { sessionId: string; invocationId: string; afterSeqId: number }, opts?: { signal?: AbortSignal }) {
    return this.client.streamGetAction('SubscribeRunEvents', {
      SessionId: params.sessionId,
      InvocationId: params.invocationId,
      AfterSeqId: String(params.afterSeqId),
    }, opts);
  }

  async submitControl(
    command: {
      command_type: 'enqueue' | 'steer' | 'inject' | 'interrupt' | 'pause' | 'resume' | 'submit_interaction';
      idempotency_key: string;
      payload: Record<string, unknown>;
    },
    opts?: { signal?: AbortSignal },
  ) {
    const data = await this.client.postJsonAction<unknown>('SubmitAgentControl', {
      CommandType: command.command_type,
      IdempotencyKey: command.idempotency_key,
      Payload: command.payload,
    }, opts);
    return decodeReceipt(data);
  }

  async submitInteraction(
    params: {
      AgentId: string;
      SessionId: string;
      RunId: string;
      InteractionId: string;
      ExpectedRevision: number;
      Action: 'approve' | 'reject' | 'submit' | 'cancel';
      Response: Record<string, unknown>;
      IdempotencyKey: string;
    },
    opts?: { signal?: AbortSignal },
  ) {
    return decodeReceipt(await this.client.postJsonAction<unknown>('SubmitInteraction', { ...params }, opts));
  }

  async getAgentStatus(opts?: { signal?: AbortSignal }) {
    return this.client.postJsonAction('GetAgentStatus', {}, opts);
  }

  async subscribeSessionEvents(sessionId: string, afterSeq: number, opts?: { signal?: AbortSignal }) {
    return this.client.streamGetAction('SubscribeSessionEvents', {
      SessionId: sessionId,
      after_seq: String(afterSeq),
    }, opts);
  }

  async cancelRun(agentId: string, sessionId: string, invocationId: string, opts?: { signal?: AbortSignal }) {
    return this.client.postJsonAction('CancelRun', {
      AgentId: agentId,
      SessionId: sessionId,
      InvocationId: invocationId,
    }, opts);
  }

  async getResponseFeedback(payload: Record<string, unknown>, opts?: { signal?: AbortSignal }) {
    return this.client.postJsonAction('GetResponseFeedback', payload, opts);
  }

  async upsertResponseFeedback(payload: Record<string, unknown>, opts?: { signal?: AbortSignal }) {
    return this.client.postJsonAction('UpsertResponseFeedback', payload, opts);
  }

  async deleteResponseFeedback(payload: Record<string, unknown>, opts?: { signal?: AbortSignal }) {
    await this.client.postJsonAction('DeleteResponseFeedback', payload, opts);
  }

  async listWorkspaceFiles(agentId: string, path: string, recursive: boolean, opts?: { signal?: AbortSignal }) {
    return this.client.postJsonAction('ListWorkspaceFiles', { AgentId: agentId, Path: path, Recursive: recursive }, opts);
  }

  async addWorkspaceFile(formData: FormData, opts?: { signal?: AbortSignal }) {
    return this.client.postFormAction('AddWorkspaceFile', formData, opts);
  }

  async deleteWorkspaceFile(agentId: string, path: string, opts?: { signal?: AbortSignal }) {
    await this.client.postJsonAction('DeleteWorkspaceFile', { AgentId: agentId, Path: path }, opts);
  }

  async getWorkspaceFileContent(agentId: string, path: string, opts?: { signal?: AbortSignal; asText?: boolean }) {
    return this.client.getResource('GetWorkspaceFileContent', { AgentId: agentId, Path: path }, opts);
  }

  async listAgentModels(agentId: string, opts?: { signal?: AbortSignal }) {
    return this.client.postJsonAction('ListAgentModels', { AgentId: agentId }, opts);
  }

  async getAgentUiBootstrap(agentId?: string, opts?: { signal?: AbortSignal }) {
    return this.client.postJsonAction('GetAgentUiBootstrap', agentId ? { AgentId: agentId } : {}, opts);
  }

  async uploadFile(formData: FormData, opts?: { signal?: AbortSignal }) {
    return this.client.postFormAction<{
      FileData: { fileUri: string; displayName: string; mimeType: string };
    }>('UploadFile', formData, opts);
  }
}
