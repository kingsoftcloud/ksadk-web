import { safeToolValue } from './safe-tool-value.js';
import { validateAgentItem } from './agent.js';
import {
  RuntimeItemReducer,
  type RuntimeItemKind,
  type RuntimeItemPart,
  type RuntimeItemOperation,
} from '../stream/runtime-items.js';
import { ConversationItemReducer } from './reducer.js';
import type {
  ConversationItem,
  ConversationItemReducerState,
} from './types.js';

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
export const runtimeConversationIdentity = (
  run: string,
  scope: string,
  item: string,
): string => JSON.stringify([run, scope, item]);

/** Compatibility ingress only. Native ConversationItem streams use their own authoritative lane. */
export class RuntimeConversationIngress {
  private readonly runtime = new RuntimeItemReducer();
  // Flat clients retain bare root IDs. Hidden child facts must never collide in that reducer.
  private readonly flatChildren = new ConversationItemReducer();
  private readonly seen = new Set<string>();
  private readonly parents = new Map<string, string>();
  private readonly descriptorItemIds = new Map<string, string>();
  private readonly descriptors = new Map<string, Record<string, unknown>>();
  private rootScope = '';
  private runId = '';
  constructor(
    private readonly sessionId: string,
    private readonly conversation = new ConversationItemReducer(),
    private readonly profile: 'agent-block-v1' | 'flat-v1' = 'agent-block-v1',
  ) {}
  private identity(run: string, scope: string, item: string, child = false): string {
    return this.profile === 'agent-block-v1' || child
      ? runtimeConversationIdentity(run, scope, item)
      : item;
  }
  snapshot(): ConversationItemReducerState {
    const root = this.conversation.snapshot();
    if (this.profile !== 'flat-v1') return root;
    const children = this.flatChildren.snapshot();
    return {
      items: [...root.items, ...children.items],
      appliedSources: [...root.appliedSources, ...children.appliedSources],
    };
  }
  apply(frame: Record<string, unknown>): ConversationItem | null {
    if (frame.schema_version !== 2) return null;
    const run = String(frame.run_id || '');
    const scope = String(frame.scope_id || '');
    const event = String(frame.event_id || '');
    const type = String(frame.event_type || '');
    if (!type.startsWith('item.') && !type.startsWith('run.')) return null;
    if (!run || !scope || !event)
      throw new Error('RuntimeEvent identity missing');
    if (this.runId && this.runId !== run)
      throw new Error('RuntimeEvent run identity changed');
    if (this.seen.has(event)) return null;
    const parent = String(frame.parent_scope_id ?? this.descriptors.get(scope)?.parent_scope_id ?? this.parents.get(scope) ?? '');
    if (
      type.startsWith('run.') &&
      (parent || (this.rootScope && scope !== this.rootScope))
    )
      throw new Error('Child scope cannot transition root run');
    if (this.parents.has(scope) && this.parents.get(scope) !== parent)
      throw new Error('Scope parent changed');
    const nativeItem = String(frame.item_id || '');
    const id = this.identity(run, scope, nativeItem || event, Boolean(parent));
    const source = record(frame.source);
    const nativeRef = Object.fromEntries(
      Object.entries({
        framework: source.framework,
        protocol: source.protocol,
        eventId: source.native_event_id,
        cursor: source.native_cursor,
        runId: source.native_run_id,
        itemId: source.native_item_id,
        scopeId: scope,
        runtimeItemId: nativeItem || undefined,
        parentScopeId: parent || undefined,
        phase: frame.phase,
      }).filter(([, value]) => value !== undefined && value !== null),
    );
    const base: ConversationItem = {
      apiVersion: 'conversation.ksadk.io/v1',
      kindVersion: 1,
      itemId: id,
      sessionId: this.sessionId,
      runId: run,
      sourceEventIds: [event],
      kind: 'progress',
      operation: 'replace',
      lifecycle: 'streaming',
      visibility: 'public',
      payloadSchemaRef: 'conversation.item.progress/v1',
      payload: {},
      nativeRef,
    };
    const visibility = record(
      record(frame.source).metadata,
    ).conversation_visibility;
    if (['public', 'internal', 'hidden'].includes(String(visibility)))
      base.visibility = visibility as ConversationItem['visibility'];
    else if (parent && frame.item_kind === 'reasoning')
      base.visibility = 'hidden';
    if (type.startsWith('run.')) {
      this.rootScope = scope;
      base.payload = {
        status: ['run.started', 'run.progress'].includes(type)
          ? 'running'
          : type.slice(4),
        ...(frame.output_refs ? { outputRefs: frame.output_refs } : {}),
      };
      if (type === 'run.progress')
        Object.assign(base.payload, {
          progress: frame.progress,
          message: frame.message,
        });
      if (type === 'run.interrupted') base.payload.reason = frame.reason || '';
      base.operation = ['run.started', 'run.progress'].includes(type)
        ? 'append'
        : 'completed';
      if (['run.failed', 'run.canceled', 'run.cancelled'].includes(type)) {
        base.kind = 'error';
        base.payloadSchemaRef = 'conversation.item.error/v1';
        base.payload.error = record(frame.error).message || frame.reason || '';
      }
      base.lifecycle = ['run.completed', 'run.interrupted'].includes(type)
        ? 'completed'
        : ['run.failed', 'run.canceled', 'run.cancelled'].includes(type)
          ? 'failed'
          : 'streaming';
    } else {
      if (!nativeItem) throw new Error('RuntimeEvent item identity missing');
      const holder = record(frame.snapshot || frame.initial);
      const rawParts =
        type === 'item.updated'
          ? [record(frame.update)]
          : Array.isArray(holder.parts)
            ? holder.parts
            : [];
      const parts: RuntimeItemPart[] = rawParts.map((value) => {
        const p = record(value);
        return {
          partId: String(p.part_id || 'part'),
          contentType: String(
            p.content_type || 'data',
          ) as RuntimeItemPart['contentType'],
          ...(typeof p.text === 'string' ? { text: p.text } : {}),
          value: p,
        };
      });
      const descriptor = rawParts
        .map((p) => record(record(p).data))
        .find((p) => p.schema === 'execution.scope/v1');
      if (parent && !descriptor) {
        const descriptorItemId = this.descriptorItemIds.get(scope);
        if (!descriptorItemId)
          throw new Error('Child content requires its scope descriptor first');
        base.parentItemId = descriptorItemId;
      }
      if (descriptor) {
        if (this.descriptorItemIds.has(scope) && this.descriptorItemIds.get(scope) !== id) throw new Error('Scope descriptor item identity changed');
        const trigger = record(descriptor.trigger_ref);
        if (
          descriptor.scope_id !== scope ||
          descriptor.parent_scope_id !== parent ||
          trigger.scope_id !== parent ||
          !trigger.item_id ||
          !trigger.call_id ||
          !parent
        )
          throw new Error('Invalid scope descriptor locator');
        const triggerItem = this.runtime
          .snapshot()
          .items.find(
            (item) =>
              item.scopeId === trigger.scope_id &&
              item.itemId === trigger.item_id,
          );
        if (
          triggerItem &&
          !triggerItem.parts.some(
            (part) => record(part.value).call_id === trigger.call_id,
          )
        )
          throw new Error('Scope trigger call mismatch');
        const previous = this.descriptors.get(scope);
        validateAgentItem(
          {
            ...base,
            kind: 'agent',
            payloadSchemaRef: 'conversation.item.agent/v1',
            payload: descriptor,
          },
          previous ? { ...base, kind: 'agent', payload: previous } : undefined,
        );
        this.descriptors.set(scope, descriptor);
        this.descriptorItemIds.set(scope, id);
      }
      for (const scopeDescriptor of this.descriptors.values()) {
        const trigger = record(scopeDescriptor.trigger_ref);
        if (
          trigger.scope_id === scope &&
          trigger.item_id === nativeItem &&
          parts.length &&
          !parts.some((part) => record(part.value).call_id === trigger.call_id)
        )
          throw new Error('Scope trigger call mismatch');
      }
      const existing = this.runtime
        .snapshot()
        .items.find((i) => i.scopeId === scope && i.itemId === nativeItem);
      if (parent && existing && existing.status !== 'open') {
        if (type === 'item.updated' || type === 'item.started')
          throw new Error('Remote item cannot reopen');
        if (
          Array.isArray(holder.parts) &&
          JSON.stringify(existing.parts) !== JSON.stringify(parts)
        )
          throw new Error('Remote terminal content conflict');
      }
      const op = {
        type: type.replaceAll('.', '_'),
        runId: run,
        scopeId: scope,
        itemId: nativeItem,
        itemKind: frame.item_kind as RuntimeItemKind,
        eventId: event,
        initialParts: parts,
        phase: frame.phase,
        ...(Array.isArray(holder.parts) ? { parts } : {}),
        ...(type === 'item.updated'
          ? {
              partId: parts[0]?.partId,
              part: parts[0],
              op: frame.op || 'replace',
            }
          : {}),
      } as RuntimeItemOperation;
      this.runtime.apply(op);
      const item = this.runtime
        .snapshot()
        .items.find((i) => i.scopeId === scope && i.itemId === nativeItem);
      if (!item) return null;
      const values = item.parts.map((p) => record(p.value));
      const data = values
        .map((p) => record(p.data))
        .find((p) => p.schema === 'execution.scope/v1');
      base.lifecycle =
        item.status === 'open'
          ? type === 'item.started'
            ? 'pending'
            : 'streaming'
          : item.status;
      base.operation = ['completed', 'failed'].includes(base.lifecycle)
        ? 'completed'
        : type === 'item.started'
          ? 'append'
          : 'replace';
      if (data) {
        base.operation = ['completed', 'failed'].includes(base.lifecycle)
          ? 'completed'
          : 'replace';
        base.kind = 'agent';
        base.payloadSchemaRef = 'conversation.item.agent/v1';
        base.payload = data;
        base.parentItemId = this.identity(
          run,
          String(record(data.trigger_ref).scope_id),
          String(record(data.trigger_ref).item_id),
          Boolean(this.parents.get(String(record(data.trigger_ref).scope_id))),
        );
        base.capabilityRef = 'agent.block';
      } else if (
        item.itemKind === 'tool_call' ||
        item.itemKind === 'tool_result'
      ) {
        const call = values.find((p) => p.content_type === 'tool_call');
        const result = values.find((p) => p.content_type === 'tool_result');
        base.kind = 'tool_call';
        base.capabilityRef = 'tool.inspect';
        base.payloadSchemaRef = 'conversation.item.tool-call/v1';
        base.payload = {
          ...(call
            ? {
                callId: call.call_id,
                tool: call.name,
                args: safeToolValue(call.arguments),
              }
            : {}),
          ...(result
            ? {
                callId: result.call_id,
                output: safeToolValue(result.result),
                isError: result.is_error,
              }
            : {}),
          executionStatus:
            item.status === 'failed' ? 'failed' : result && item.status !== 'open'
              ? result.is_error
                ? 'failed'
                : 'completed'
              : item.itemKind === 'tool_result'
                ? 'unknown'
                : 'running',
          sourceKind: item.itemKind,
        };
      } else if (item.itemKind === 'message' || item.itemKind === 'reasoning') {
        base.kind =
          item.itemKind === 'reasoning'
            ? 'reasoning'
            : record(record(frame.source).metadata).native_item_kind ===
                'userMessage'
              ? 'user_message'
              : 'assistant_text';
        base.payloadSchemaRef = `conversation.item.${base.kind}/v1`;
        base.payload = { text: item.parts.map((p) => p.text || '').join('') };
        if (type === 'item.updated' && frame.op === 'append') {
          base.operation = 'append';
          base.payload.text = record(frame.update).text || '';
        }
      } else if (item.itemKind === 'artifact') {
        const artifact =
          values.find((p) => p.content_type === 'artifact') || {};
        base.kind = 'artifact';
        base.payloadSchemaRef = 'conversation.item.artifact/v1';
        base.payload = {
          name: artifact.name,
          mimeType: artifact.mime_type,
          uri: artifact.uri,
        };
      } else {
        base.visibility = visibility === 'public' ? 'public' : 'hidden';
        base.kind = 'unknown';
        base.payloadSchemaRef = 'conversation.item.unknown/v1';
        base.payload = { summary: 'Unsupported runtime content' };
      }
    }
    this.runId = run;
    this.parents.set(scope, parent);
    this.seen.add(event);
    const reducer = this.profile === 'flat-v1' && parent
      ? this.flatChildren
      : this.conversation;
    reducer.apply(base);
    return base;
  }
}
