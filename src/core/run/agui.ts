import {
  buildResumeArray,
  HttpAgent,
  type AgentSubscriber,
  type RunAgentResult,
} from '@ag-ui/client';
import type { BaseEvent, Interrupt } from '@ag-ui/core';
import type { RunEvent } from './types.js';
import { a2uiAgentContext, normalizeA2uiOperations } from './a2ui.js';
import { defaultA2uiCatalogRegistry, type A2uiCatalogRegistry } from '../a2ui/registry.js';
import { isTerminalInteraction, type Interaction } from '../interaction/types.js';

type AguiRunStatus = 'completed' | 'interrupted' | 'failed' | 'cancelled';

type AguiRunResult = {
  status: AguiRunStatus;
  result: RunAgentResult;
  pendingInterruptIds: string[];
};

type AguiRunClientOptions = {
  url: string;
  agentId: string;
  threadId: string;
  onEvent: (event: RunEvent) => void;
  fetch?: typeof fetch;
  forwardedProps?: Record<string, unknown>;
  a2uiCatalogRegistry?: A2uiCatalogRegistry;
};

type TextSnapshot = { messageId: string; content: string };

type ToolState = { name: string; args: string };

function eventType(event: BaseEvent): string {
  return String((event as { type?: unknown }).type || '').toUpperCase();
}

function eventMessageId(event: BaseEvent, fallback: string): string {
  return String((event as { messageId?: unknown }).messageId || fallback);
}

function eventRunId(event: BaseEvent, fallback: string): string {
  return String((event as { runId?: unknown }).runId || fallback);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function activityMessages(content: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(content)) {
    return normalizeA2uiOperations(
      content.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')),
    );
  }
  if (content && typeof content === 'object') {
    const operations = (content as Record<string, unknown>).a2ui_operations;
    if (Array.isArray(operations)) {
      return normalizeA2uiOperations(
        operations.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')),
      );
    }
    return [content as Record<string, unknown>];
  }
  return [];
}

function stringifyPayload(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

export class AguiRunClient {
  private readonly agent: HttpAgent;
  private readonly onEvent: (event: RunEvent) => void;
  private readonly tools = new Map<string, ToolState>();
  private readonly runMessageIds = new Map<string, string>();
  private readonly pendingByRun = new Map<string, Interrupt[]>();
  private activeRunId = '';
  private logicalRunId = '';
  private executionEpoch = 0;
  private readonly threadId: string;
  private forwardedProps: Record<string, unknown>;
  private catalogRegistry: A2uiCatalogRegistry;

  constructor(options: AguiRunClientOptions) {
    this.agent = new HttpAgent({
      url: options.url,
      agentId: options.agentId,
      threadId: options.threadId,
      fetch: options.fetch,
    });
    this.onEvent = options.onEvent;
    this.threadId = options.threadId;
    this.forwardedProps = options.forwardedProps || {};
    this.catalogRegistry = options.a2uiCatalogRegistry || defaultA2uiCatalogRegistry;
  }

  configure(forwardedProps: Record<string, unknown>, registry = defaultA2uiCatalogRegistry) {
    this.forwardedProps = forwardedProps;
    this.catalogRegistry = registry;
  }

  /** Canonical submissions finish on the session stream, outside HttpAgent.resume(). */
  reconcileInteractions(interactions: readonly Interaction[]): void {
    const remainsPending = (interrupt: Interrupt) => !interactions.some(record =>
      interrupt.metadata?.interaction_v1 === true
      && record.source === 'interaction_v1'
      && record.sessionId === this.threadId
      && record.interactionId === interrupt.id
      && record.runId === interrupt.metadata.run_id
      && record.revision >= Number(interrupt.metadata.revision || 1)
      && isTerminalInteraction(record.status));
    // pendingInterrupts is the official client's public mutable state. An Inbox
    // receipt is insufficient; keep unresolved waits and the legacy resume path.
    this.agent.pendingInterrupts = this.agent.pendingInterrupts.filter(remainsPending);
    for (const [runId, interrupts] of this.pendingByRun) {
      const pending = interrupts.filter(remainsPending);
      if (pending.length) this.pendingByRun.set(runId, pending);
      else this.pendingByRun.delete(runId);
    }
  }

  async run(text: string, runId: string, signal?: AbortSignal): Promise<AguiRunResult> {
    this.activeRunId = runId;
    this.logicalRunId = runId;
    this.agent.addMessage({
      id: `${runId}:user`,
      role: 'user',
      content: text,
    });
    return this.execute({ runId, abortController: this.controllerFor(signal) });
  }

  async resume(
    runId: string,
    response: { interruptId: string; status: 'resolved' | 'cancelled'; payload?: unknown; logicalRunId?: string },
  ): Promise<AguiRunResult> {
    if (response.status === 'resolved' && response.payload === null) {
      throw new Error('AG-UI 1.0 根 null 答案须通过 Interaction/v1 提交。');
    }
    const rememberedInterrupts = this.agent.pendingInterrupts.length > 0
      ? this.agent.pendingInterrupts
      : this.pendingByRun.get(this.activeRunId) || [];
    // A browser refresh drops HttpAgent's in-memory interrupt list. The server
    // is still authoritative for its durable thread, so send the official
    // resume shape for the persisted interrupt id instead of rejecting it.
    const interrupts = rememberedInterrupts.length > 0
      ? rememberedInterrupts.filter(interrupt => interrupt.id === response.interruptId)
      : [{ id: response.interruptId, reason: 'approval' } satisfies Interrupt];
    const resume = buildResumeArray(interrupts, {
      [response.interruptId]: response.status === 'resolved'
        ? { status: 'resolved', payload: response.payload }
        : { status: 'cancelled' },
    });
    if (!resume.some((entry) => entry.interruptId === response.interruptId)) {
      throw new Error(`AG-UI interrupt ${response.interruptId} is not pending`);
    }
    const originalRun = interrupts.find(interrupt => interrupt.id === response.interruptId)?.metadata?.run_id;
    this.logicalRunId = response.logicalRunId || (typeof originalRun === 'string' ? originalRun : '')
      || this.logicalRunId || this.activeRunId || runId;
    this.activeRunId = runId;
    return this.execute({ runId, resume });
  }

  abort(): void {
    this.executionEpoch += 1;
    this.agent.abortRun();
  }

  private controllerFor(signal?: AbortSignal): AbortController | undefined {
    if (!signal) return undefined;
    const controller = new AbortController();
    if (signal.aborted) controller.abort(signal.reason);
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    return controller;
  }

  private async execute(parameters: {
    runId: string;
    resume?: ReturnType<typeof buildResumeArray>;
    abortController?: AbortController;
  }): Promise<AguiRunResult> {
    const epoch = ++this.executionEpoch;
    const logicalRunId = this.logicalRunId || parameters.runId;
    let acceptSnapshots = true;
    const messageIds = new Set<string>();
    const textSnapshot = (event: BaseEvent): TextSnapshot | null => {
      if (!acceptSnapshots || epoch !== this.executionEpoch || this.activeRunId !== parameters.runId
        || parameters.abortController?.signal.aborted) return null;
      const payload = event as unknown as Record<string, unknown>;
      if (eventType(event) !== 'CUSTOM' || payload.name !== 'ksadk.text_message_snapshot') return null;
      const value = asObject(payload.value);
      return value.version === 1 && value.threadId === this.threadId && value.runId === parameters.runId
        && typeof value.messageId === 'string' && messageIds.has(value.messageId) && typeof value.content === 'string'
        ? { messageId: value.messageId, content: value.content } : null;
    };
    let status = 'completed' as AguiRunStatus;
    let finished = false;
    const subscriber: AgentSubscriber = {
      onEvent: ({ event, messages }) => {
        if (eventType(event) === 'TEXT_MESSAGE_START') messageIds.add(eventMessageId(event, `${parameters.runId}:assistant`));
        const snapshot = textSnapshot(event);
        if (snapshot && messages.some(message => message.id === snapshot.messageId && message.role === 'assistant')) {
          this.onEvent({ type: 'text_replace', messageId: snapshot.messageId, text: snapshot.content, sessionId: this.threadId });
        }
        if (eventType(event) === 'RUN_FINISHED') finished = true;
        if (eventType(event) === 'RUN_ERROR'
          && (event as BaseEvent & { code?: string }).code === 'INPUT_RESPONSE_INVALID') {
          for (const entry of parameters.resume || []) this.onEvent({
            type: 'interaction_submit_rejected', interactionId: entry.interruptId,
            message: '答案未通过 Runtime 校验，请修改后重新提交。',
          });
        }
        const result = this.project(event, parameters.runId, Boolean(parameters.resume?.length), logicalRunId);
        if (result.status) status = result.status;
        result.events.forEach((item) => this.onEvent(item));
      },
      onCustomEvent: ({ event, messages }) => {
        const snapshot = textSnapshot(event);
        if (!snapshot || !messages.some(message => message.id === snapshot.messageId && message.role === 'assistant')) return;
        return { messages: messages.map(message => message.id === snapshot.messageId && message.role === 'assistant'
          ? { ...message, content: snapshot.content } : message) };
      },
      onRunFinishedEvent: ({ outcome }) => {
        status = outcome === 'interrupt' ? 'interrupted' : 'completed';
      },
      onRunErrorEvent: () => {
        status = 'failed';
      },
    };
    let result: RunAgentResult;
    try {
      result = await this.agent.runAgent({
        runId: parameters.runId,
        context: [a2uiAgentContext(this.catalogRegistry)],
        forwardedProps: { ...this.forwardedProps, injectA2UITool: true },
        resume: parameters.resume,
        abortController: parameters.abortController,
      }, subscriber);
    } finally { acceptSnapshots = false; }
    const pending = this.pendingByRun.get(parameters.runId) || this.agent.pendingInterrupts.slice();
    if (pending.length > 0) {
      this.pendingByRun.set(parameters.runId, pending);
      if (status !== 'failed') status = 'interrupted';
    }
    return { status: finished ? status : 'failed', result, pendingInterruptIds: pending.map(item => item.id) };
  }

  private project(event: BaseEvent, fallbackRunId: string, resuming = false, logicalRunId = fallbackRunId): { events: RunEvent[]; status?: AguiRunStatus } {
    const type = eventType(event);
    const runId = eventRunId(event, fallbackRunId);
    const messageId = eventMessageId(event, `${runId}:assistant`);
    const payload = event as unknown as Record<string, unknown>;
    const events: RunEvent[] = [];

    if (type === 'RUN_STARTED') {
      events.push({ type: 'activity', phase: 'AG-UI 运行已创建', status: 'running', countEvent: false });
    } else if (type === 'TEXT_MESSAGE_START') {
      this.runMessageIds.set(runId, messageId);
      events.push({ type: 'assistant_message_created', messageId, invocationId: logicalRunId });
    } else if (type === 'TEXT_MESSAGE_CONTENT') {
      events.push({ type: 'text_delta', messageId: this.runMessageIds.get(runId) || messageId, delta: String(payload.delta || '') });
    } else if (type === 'TEXT_MESSAGE_END') {
      events.push({ type: 'activity', phase: '生成回复内容', status: 'running' });
    } else if (type === 'REASONING_MESSAGE_CONTENT') {
      events.push({ type: 'reasoning_delta', messageId: this.runMessageIds.get(runId) || messageId, delta: String(payload.delta || '') });
    } else if (type === 'TOOL_CALL_START') {
      const toolCallId = String(payload.toolCallId || 'tool');
      this.tools.set(toolCallId, { name: String(payload.toolCallName || 'tool'), args: '' });
      events.push({ type: 'tool_upsert', messageId: this.runMessageIds.get(runId) || `${runId}:assistant`, name: String(payload.toolCallName || 'tool'), args: '', status: 'running' });
    } else if (type === 'TOOL_CALL_ARGS') {
      const toolCallId = String(payload.toolCallId || 'tool');
      const tool = this.tools.get(toolCallId) || { name: 'tool', args: '' };
      tool.args += String(payload.delta || '');
      this.tools.set(toolCallId, tool);
      events.push({ type: 'tool_upsert', messageId: this.runMessageIds.get(runId) || `${runId}:assistant`, name: tool.name, args: tool.args, status: 'running' });
    } else if (type === 'TOOL_CALL_RESULT') {
      const toolCallId = String(payload.toolCallId || 'tool');
      const tool = this.tools.get(toolCallId) || { name: 'tool', args: '' };
      events.push({ type: 'tool_result', messageId: this.runMessageIds.get(runId) || `${runId}:assistant`, name: tool.name, output: String(payload.content || '') });
    } else if (type === 'CUSTOM' && payload.name === 'ksadk.session_event') {
      const envelope = asObject(payload.value);
      if (envelope.family === 'interaction' && envelope.family_version === 1
        && envelope.session_id === this.threadId && typeof envelope.event_type === 'string'
        && Number.isSafeInteger(envelope.seq)) {
        events.push({
          type: 'stream_event', sessionId: envelope.session_id,
          event: {
            EventId: String(envelope.event_id || ''), EventType: envelope.event_type,
            SessionId: envelope.session_id, InvocationId: String(envelope.run_id || ''),
            SeqId: Number(envelope.seq), Content: { session_event: envelope },
          },
        });
      }
    } else if (type === 'ACTIVITY_SNAPSHOT') {
      const content = payload.content;
      const activity = asObject(content);
      const surfaceId = String(activity.surfaceId || activity.surface_id || payload.messageId || 'default');
      events.push({
        type: 'agui_activity',
        runId: logicalRunId,
        ...(typeof activity.batchId === 'string' ? { batchId: activity.batchId } : {}),
        ...(typeof activity.interactionId === 'string' ? { interactionId: activity.interactionId } : {}),
        // A2UI operations belong to the assistant turn that produced them.
        // Keeping the activity on a standalone message lets later text tokens
        // push the card above the scroll position, which looks like it only
        // appears after a history reload.
        messageId: this.runMessageIds.get(runId) || messageId,
        surfaceId,
        messages: activityMessages(activity.content ?? content),
      });
    } else if (type === 'RUN_FINISHED') {
      const outcome = asObject(payload.outcome);
      if (String(outcome.type || '').toLowerCase() === 'interrupt') {
        const interrupts = Array.isArray(outcome.interrupts) ? outcome.interrupts : [];
        this.pendingByRun.set(runId, interrupts as Interrupt[]);
        for (const interrupt of interrupts as Interrupt[]) {
          const metadata = asObject(interrupt.metadata);
          // Its durable request has already arrived through CUSTOM on the
          // shared Session cursor. Do not overwrite it with a legacy card
          // whose wire attempt ID differs from the original logical Run.
          if (metadata.interaction_v1 === true) continue;
          const tool = interrupt.toolCallId ? this.tools.get(interrupt.toolCallId) : undefined;
          const name = String(
            metadata.tool_name
            || metadata.toolName
            || tool?.name
            || interrupt.reason
            || '人工确认',
          );
          const args = stringifyPayload(
            metadata.arguments
            ?? metadata.tool_args
            ?? metadata.args
            ?? tool?.args,
          );
          events.push({
            type: 'approval_requested',
            messageId: this.runMessageIds.get(runId) || `${runId}:assistant`,
            approvalRequestId: interrupt.id,
            protocol: 'ag-ui',
            ...(interrupt.responseSchema ? { requestSchema: interrupt.responseSchema } : {}),
            name,
            args,
            ...(interrupt.message ? { message: interrupt.message } : {}),
            ...(metadata.approval_level ? { approvalLevel: String(metadata.approval_level) } : {}),
          });
        }
        events.push({ type: 'activity', phase: '等待人工确认', status: 'waiting' });
        return { events, status: 'interrupted' };
      }
      // Resume consumption is confirmed by RunEngine before its terminal
      // frame closes unresolved cards. A new wait is not a terminal run.
      if (!resuming) events.push({ type: 'terminal', status: 'completed' });
      this.pendingByRun.set(runId, []);
    } else if (type === 'RUN_ERROR') {
      events.push({ type: 'error', error: new Error('AG-UI 运行失败') });
      return { events, status: 'failed' };
    }
    return { events };
  }
}
