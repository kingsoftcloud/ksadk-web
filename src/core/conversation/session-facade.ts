import type { ApiFacade } from '../api/types.js';
import type { AgentControlReceipt } from '../../types/agent-control.js';
import type { ConversationBinding, ConversationId } from './studio-controller.js';

export type SessionSummary = {
  sessionId: string;
  title?: string;
  updatedAt?: string;
  activeRunStatus?: string;
  activeInvocationId?: string;
};

export type SessionOwner = { agentId: string; targetId?: string; tenantId?: string; workspaceId?: string };

export type SessionFacade = {
  listSessionSummaries(options?: { page?: number; pageSize?: number; signal?: AbortSignal }): Promise<{ items: SessionSummary[]; total: number; nextPage?: number }>;
  readHistoryWindow(binding: ConversationBinding, options?: { offset?: number; limit?: number; signal?: AbortSignal }): Promise<{ items: unknown[]; total: number; nextOffset?: number }>;
  watchCurrentState(binding: ConversationBinding, options?: { signal?: AbortSignal }): Promise<SessionSummary>;
  ensureExecutionBinding(conversationId: ConversationId, options?: { signal?: AbortSignal }): Promise<ConversationBinding>;
  submit(binding: ConversationBinding, input: { text: string; clientRequestId: string; idempotencyKey: string }, options?: { signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>>;
  interrupt(binding: ConversationBinding, invocationId: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  approve(binding: ConversationBinding, input: { interactionId: string; runId: string; expectedRevision: number; approve: boolean; idempotencyKey: string }, options?: { signal?: AbortSignal }): Promise<AgentControlReceipt>;
};

/** Adapter that gives Studio one Query / Command / Feed boundary over the existing API. */
export class ApiSessionFacade implements SessionFacade {
  private readonly bindings = new Map<ConversationId, ConversationBinding>();
  private readonly pendingBindings = new Map<ConversationId, Promise<ConversationBinding>>();
  constructor(private readonly api: ApiFacade, private readonly owner: SessionOwner) {}

  async listSessionSummaries(options: { page?: number; pageSize?: number; signal?: AbortSignal } = {}) {
    const data = await this.api.listSessions(this.owner.agentId, options);
    const items = (data.Sessions as Array<Record<string, unknown>>).map((item) => ({
      sessionId: String(item.SessionId || ''),
      title: item.Title ? String(item.Title) : undefined,
      updatedAt: item.UpdatedAt ? String(item.UpdatedAt) : undefined,
      activeRunStatus: item.ActiveRunStatus ? String(item.ActiveRunStatus) : undefined,
      activeInvocationId: item.ActiveInvocationId ? String(item.ActiveInvocationId) : undefined,
    })).filter((item) => item.sessionId);
    const page = options.page || 1;
    const pageSize = options.pageSize || items.length;
    return { items, total: Number(data.Total ?? items.length), nextPage: items.length >= pageSize ? page + 1 : undefined };
  }

  async readHistoryWindow(binding: ConversationBinding, options: { offset?: number; limit?: number; signal?: AbortSignal } = {}) {
    if (!binding.nativeSessionId) return { items: [], total: 0 };
    const data = await this.api.listSessionMessages(binding.nativeSessionId, {
      agentId: this.owner.agentId, afterSeqId: options.offset, limit: options.limit, signal: options.signal,
    });
    const offset = options.offset || 0;
    return { items: data.Messages, total: data.LatestSeqId, nextOffset: data.HasMore ? offset + data.Messages.length : undefined };
  }

  async watchCurrentState(binding: ConversationBinding, options: { signal?: AbortSignal } = {}) {
    if (!binding.nativeSessionId) return { sessionId: '', title: undefined };
    const data = await this.api.getSession(binding.nativeSessionId, options);
    return { sessionId: data.SessionId, title: data.Title, updatedAt: data.UpdatedAt, activeRunStatus: data.ActiveRunStatus, activeInvocationId: data.ActiveInvocationId };
  }

  async ensureExecutionBinding(conversationId: ConversationId, options: { signal?: AbortSignal } = {}) {
    const existing = this.bindings.get(conversationId);
    if (existing?.nativeSessionId) return existing;
    const pending = this.pendingBindings.get(conversationId);
    if (pending) return pending;
    const creation = this.api.createSession(this.owner.agentId, options)
      .then((session) => {
        if (!session.SessionId) throw new Error('Runtime returned no native session identity');
        const binding: ConversationBinding = {
          conversationId,
          agentId: this.owner.agentId,
          targetId: this.owner.targetId,
          nativeSessionId: session.SessionId,
        };
        this.bindings.set(conversationId, binding);
        return binding;
      })
      .finally(() => {
        if (this.pendingBindings.get(conversationId) === creation) this.pendingBindings.delete(conversationId);
      });
    this.pendingBindings.set(conversationId, creation);
    return creation;
  }

  submit(binding: ConversationBinding, input: { text: string; clientRequestId: string; idempotencyKey: string }, options: { signal?: AbortSignal } = {}) {
    if (!binding.nativeSessionId) return Promise.reject(new Error('Execution binding is required before submit'));
    const content = [{ type: 'input_text', text: input.text }];
    return this.api.runAgent({
      AgentId: this.owner.agentId,
      SessionId: binding.nativeSessionId,
      Messages: [{ role: 'user', content }],
      ResponsesInput: [{ role: 'user', content }],
      InvocationId: input.clientRequestId,
      IdempotencyKey: input.idempotencyKey,
      Metadata: { agentengine: { client_request_id: input.clientRequestId } },
      Stream: true,
    }, options);
  }

  interrupt(binding: ConversationBinding, invocationId: string, options: { signal?: AbortSignal } = {}) {
    if (!binding.nativeSessionId) return Promise.reject(new Error('Execution binding is required before interrupt'));
    if (!invocationId.trim()) return Promise.reject(new Error('Invocation identity is required before interrupt'));
    return this.api.cancelRun(this.owner.agentId, binding.nativeSessionId, invocationId, options);
  }

  approve(binding: ConversationBinding, input: { interactionId: string; runId: string; expectedRevision: number; approve: boolean; idempotencyKey: string }, options: { signal?: AbortSignal } = {}) {
    if (!binding.nativeSessionId) return Promise.reject(new Error('Execution binding is required before approve'));
    return this.api.submitInteraction({ AgentId: this.owner.agentId, SessionId: binding.nativeSessionId, RunId: input.runId, InteractionId: input.interactionId, ExpectedRevision: input.expectedRevision, Action: input.approve ? 'approve' : 'reject', Response: {}, IdempotencyKey: input.idempotencyKey }, options);
  }
}
