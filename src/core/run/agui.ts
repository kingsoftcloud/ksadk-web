import {
  buildResumeArray,
  HttpAgent,
  type AgentSubscriber,
  type RunAgentResult,
} from '@ag-ui/client';
import type { BaseEvent, Interrupt } from '@ag-ui/core';
import type { RunEvent } from './types.js';
import { ksadkA2uiAgentContext, normalizeA2uiOperations } from './a2ui.js';

type AguiRunStatus = 'completed' | 'interrupted' | 'failed' | 'cancelled';

type AguiRunResult = {
  status: AguiRunStatus;
  result: RunAgentResult;
};

type AguiRunClientOptions = {
  url: string;
  agentId: string;
  threadId: string;
  onEvent: (event: RunEvent) => void;
  fetch?: typeof fetch;
};

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

  constructor(options: AguiRunClientOptions) {
    this.agent = new HttpAgent({
      url: options.url,
      agentId: options.agentId,
      threadId: options.threadId,
      fetch: options.fetch,
    });
    this.onEvent = options.onEvent;
  }

  async run(text: string, runId: string, signal?: AbortSignal): Promise<AguiRunResult> {
    this.activeRunId = runId;
    this.agent.addMessage({
      id: `${runId}:user`,
      role: 'user',
      content: text,
    });
    return this.execute({ runId, abortController: this.controllerFor(signal) });
  }

  async resume(
    runId: string,
    response: { interruptId: string; status: 'resolved' | 'cancelled'; payload?: unknown },
  ): Promise<AguiRunResult> {
    const rememberedInterrupts = this.agent.pendingInterrupts.length > 0
      ? this.agent.pendingInterrupts
      : this.pendingByRun.get(this.activeRunId) || [];
    // A browser refresh drops HttpAgent's in-memory interrupt list. The server
    // is still authoritative for its durable thread, so send the official
    // resume shape for the persisted interrupt id instead of rejecting it.
    const interrupts = rememberedInterrupts.length > 0
      ? rememberedInterrupts
      : [{ id: response.interruptId, reason: 'approval' } satisfies Interrupt];
    const resume = buildResumeArray(interrupts, {
      [response.interruptId]: response.status === 'resolved'
        ? { status: 'resolved', payload: response.payload }
        : { status: 'cancelled' },
    });
    if (!resume.some((entry) => entry.interruptId === response.interruptId)) {
      throw new Error(`AG-UI interrupt ${response.interruptId} is not pending`);
    }
    this.activeRunId = runId;
    return this.execute({ runId, resume });
  }

  abort(): void {
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
    let status: AguiRunStatus = 'completed';
    const subscriber: AgentSubscriber = {
      onEvent: ({ event }) => {
        const result = this.project(event, parameters.runId);
        if (result.status) status = result.status;
        result.events.forEach((item) => this.onEvent(item));
      },
      onRunFinishedEvent: ({ outcome }) => {
        status = outcome === 'interrupt' ? 'interrupted' : 'completed';
      },
      onRunErrorEvent: () => {
        status = 'failed';
      },
    };
    const result = await this.agent.runAgent({
      runId: parameters.runId,
      context: [ksadkA2uiAgentContext],
      forwardedProps: { injectA2UITool: true },
      resume: parameters.resume,
      abortController: parameters.abortController,
    }, subscriber);
    const pending = this.agent.pendingInterrupts.slice();
    if (pending.length > 0) {
      this.pendingByRun.set(parameters.runId, pending);
      status = 'interrupted';
    }
    return { status, result };
  }

  private project(event: BaseEvent, fallbackRunId: string): { events: RunEvent[]; status?: AguiRunStatus } {
    const type = eventType(event);
    const runId = eventRunId(event, fallbackRunId);
    const messageId = eventMessageId(event, `${runId}:assistant`);
    const payload = event as unknown as Record<string, unknown>;
    const events: RunEvent[] = [];

    if (type === 'RUN_STARTED') {
      events.push({ type: 'activity', phase: 'AG-UI 运行已创建', status: 'running', countEvent: false });
    } else if (type === 'TEXT_MESSAGE_START') {
      this.runMessageIds.set(runId, messageId);
      events.push({ type: 'assistant_message_created', messageId });
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
    } else if (type === 'ACTIVITY_SNAPSHOT') {
      const content = payload.content;
      const activity = asObject(content);
      const surfaceId = String(activity.surfaceId || activity.surface_id || payload.messageId || 'default');
      events.push({
        type: 'agui_activity',
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
            name,
            args,
            ...(interrupt.message ? { message: interrupt.message } : {}),
            ...(metadata.approval_level ? { approvalLevel: String(metadata.approval_level) } : {}),
          });
        }
        events.push({ type: 'activity', phase: '等待人工确认', status: 'waiting' });
        return { events, status: 'interrupted' };
      }
      events.push({ type: 'terminal', status: 'completed' });
    } else if (type === 'RUN_ERROR') {
      events.push({ type: 'error', error: new Error('AG-UI 运行失败') });
      return { events, status: 'failed' };
    }
    return { events };
  }
}
