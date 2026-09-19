import { safeToolValue } from './safe-tool-value.js';
/**
 * Hosted UI presentation bridge for an already-reduced canonical snapshot.
 *
 * Identity, append/replace/completed, reconnect replay and terminal monotonicity
 * remain exclusively owned by ConversationItemReducer/HttpConversationClient.
 * This module only maps the passive shared projection into existing Hosted UI
 * view models; it never reduces provider events itself.
 */
import type { Message } from '../../components/chat/types.js';
import type { ProcessingBlock } from '../run/blocks.js';
import type { Interaction } from '../interaction/types.js';
import type {
  ConversationItem,
  ConversationStreamResult,
  ConversationTimelineEntry,
} from './types.js';

export type HostedConversationProjection = {
  messages: Message[];
  interactions: Interaction[];
};

const EVENT_TYPE = 'conversation_item_v1';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function messageBase(item: ConversationItem): Pick<
  Message,
  'id' | 'timestamp' | 'eventType' | 'eventId' | 'runId' | 'itemId' | 'status'
> {
  return {
    id: `conversation:${item.runId}:${item.itemId}`,
    // ConversationItem/v1 does not claim a wall-clock timestamp. Keep the
    // deterministic epoch value instead of inventing a time on every replay.
    timestamp: 0,
    eventType: EVENT_TYPE,
    eventId: item.sourceEventIds.at(-1),
    runId: item.runId,
    itemId: item.itemId,
    status: item.lifecycle === 'failed'
      ? 'failed'
      : item.lifecycle === 'completed'
        ? 'completed'
        : 'running',
  };
}

function blockStatus(item: ConversationItem): 'streaming' | 'done' | 'error' {
  if (item.lifecycle === 'failed') return 'error';
  return item.lifecycle === 'completed' ? 'done' : 'streaming';
}

function textMessage(item: ConversationItem): Message {
  const text = typeof item.payload.text === 'string' ? item.payload.text : '';
  if (item.kind === 'user_message') {
    return { ...messageBase(item), role: 'user', content: text, eventType: 'user_message' };
  }
  const block: ProcessingBlock = item.kind === 'reasoning'
    ? {
        id: `conversation-block:${item.itemId}`,
        type: 'thinking',
        content: text,
        status: blockStatus(item),
      }
    : {
        id: `conversation-block:${item.itemId}`,
        type: 'text',
        content: text,
        status: blockStatus(item),
      };
  return {
    ...messageBase(item),
    role: 'model',
    content: item.kind === 'assistant_text' ? text : '',
    reasoning: item.kind === 'reasoning' ? text : undefined,
    blocks: [block],
  };
}

function toolMessage(item: ConversationItem): Message {
  const toolName = nonEmptyString(item.payload.tool) || (item.payload.sourceKind === 'tool_result' ? 'Tool result' : 'Tool');
  const callId = nonEmptyString(item.payload.callId);
  const args = displayValue(safeToolValue(item.payload.args));
  const output = Object.prototype.hasOwnProperty.call(item.payload, 'output')
    ? displayValue(safeToolValue(item.payload.output))
    : undefined;
  const executionStatuses = {
    failed: 'error',
    completed: 'completed',
    running: 'running',
    unknown: 'unknown',
  } as const;
  const explicit = item.payload.executionStatus;
  const status = typeof explicit === 'string' && Object.hasOwn(executionStatuses, explicit)
    ? executionStatuses[explicit as keyof typeof executionStatuses]
    : item.lifecycle === 'failed' || item.payload.isError === true
      ? 'error'
      : item.lifecycle === 'completed' ? 'completed' : 'running';
  return {
    ...messageBase(item),
    role: 'model',
    content: '',
    blocks: [{
      id: `conversation-block:${item.itemId}`,
      type: 'tool',
      toolName,
      args,
      output,
      status,
      ...(callId ? { extra: { callId } } : {}),
    }],
    tools: {
      [toolName]: {
        name: toolName,
        ...(callId ? { callId } : {}),
        args,
        output,
        status,
      },
    },
  };
}

function interactionKind(value: unknown): Interaction['kind'] {
  return value === 'structured_input'
    ? 'structured_input'
    : value === 'plan_review'
      ? 'plan_review'
      : value === 'custom'
        ? 'custom'
        : 'approval';
}

function interactionFromItem(item: ConversationItem): Interaction | null {
  const interactionId = nonEmptyString(item.payload.interactionId);
  const revision = item.payload.revision;
  // SubmitInteraction is revision-CAS. Missing revisions are intentionally
  // read-only; inventing revision 0 could approve the wrong durable request.
  if (!interactionId || !Number.isInteger(revision) || Number(revision) < 1) {
    return null;
  }
  const detail = displayValue(item.payload.detail);
  const prompt = nonEmptyString(item.payload.prompt) || detail;
  const kind = interactionKind(item.payload.interactionKind);
  const completed = item.lifecycle === 'completed';
  return {
    interactionId,
    sessionId: item.sessionId,
    runId: item.runId,
    kind,
    title: nonEmptyString(item.payload.title)
      || (kind === 'approval'
        ? `审批：${nonEmptyString(item.payload.kind) || '操作'}`
        : '需要补充信息'),
    message: prompt || '运行需要人工确认。',
    requestSchema: record(item.payload.inputSchema),
    presentation: null,
    status: completed ? 'resolved' : 'pending',
    revision: Number(revision),
    createdAt: nonEmptyString(item.payload.createdAt) || '',
    expiresAt: nonEmptyString(item.payload.expiresAt),
    resolvedAt: completed ? nonEmptyString(item.payload.resolvedAt) : null,
    actor: completed ? nonEmptyString(item.payload.actor) : null,
    outcome: completed && ['approved', 'rejected', 'submitted', 'cancelled', 'expired']
      .includes(String(item.payload.outcome || ''))
      ? item.payload.outcome as Interaction['outcome']
      : null,
    responseSummary: completed
      ? nonEmptyString(item.payload.responseSummary)
      : null,
    source: 'interaction_v1',
    extensions: {
      conversation_item_id: item.itemId,
      ...(nonEmptyString(item.payload.callId)
        ? { call_id: nonEmptyString(item.payload.callId)! }
        : {}),
    },
  };
}

function approvalMessage(item: ConversationItem, interaction: Interaction): Message {
  const toolName = nonEmptyString(item.payload.kind) || 'approval';
  const args = displayValue(item.payload.detail);
  const approvalStatus = interaction.status === 'resolved'
    ? interaction.outcome === 'rejected'
      ? 'rejected' as const
      : interaction.outcome === 'cancelled' || interaction.outcome === 'expired'
        ? 'cancelled' as const
        : 'approved' as const
    : 'pending' as const;
  const status = interaction.status === 'pending' ? 'paused' as const : 'completed' as const;
  const extra = {
    approvalRequestId: interaction.interactionId,
    approvalStatus,
    approvalMessage: interaction.message,
  };
  return {
    ...messageBase(item),
    role: 'model',
    content: '',
    blocks: [{
      id: `conversation-block:${item.itemId}`,
      type: 'tool',
      toolName,
      args,
      status,
      extra,
    }],
    tools: {
      [toolName]: {
        name: toolName,
        args,
        status,
        approvalRequestId: interaction.interactionId,
        approvalStatus,
        approvalMessage: interaction.message,
      },
    },
  };
}

function operationSurfaceId(operation: Record<string, unknown>): string | null {
  for (const key of ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface']) {
    const payload = record(operation[key]);
    const surfaceId = nonEmptyString(payload?.surfaceId);
    if (surfaceId) return surfaceId;
  }
  return null;
}

function a2uiMessage(item: ConversationItem): Message | null {
  const raw = Array.isArray(item.payload.data)
    ? item.payload.data
    : Array.isArray(item.payload.operations)
      ? item.payload.operations
      : null;
  if (!raw) return null;
  const operations = raw.map(record);
  if (operations.some((operation) => operation === null)) return null;
  const messages = operations as Array<Record<string, unknown>>;
  const surfaceId = nonEmptyString(item.payload.surfaceId)
    || messages.map(operationSurfaceId).find((value) => value !== null)
    || null;
  if (!surfaceId) return null;
  return {
    ...messageBase(item),
    role: 'a2ui',
    content: '',
    aguiActivity: { surfaceId, messages },
  };
}

function fallbackMessage(
  item: ConversationItem,
  title: string,
  detail: string,
  failed = false,
): Message {
  return {
    ...messageBase(item),
    role: 'system',
    content: detail ? `${title}: ${detail}` : title,
    status: failed ? 'failed' : messageBase(item).status,
  };
}

/** A collapsed progress excerpt must come from an explicitly public text item. */
function latestPublicAgentSummary(entries: ConversationTimelineEntry[]): string | undefined {
  for (const { item } of [...entries].reverse()) {
    if (item.visibility !== 'public' || item.kind !== 'assistant_text'
      || item.payloadSchemaRef !== 'conversation.item.assistant_text/v1'
      || typeof item.payload.text !== 'string') continue;
    const safe = safeToolValue(item.payload.text);
    if (typeof safe !== 'string' || safe === '[redacted]') continue;
    const text = safe.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const characters = Array.from(text);
    return characters.length > 160 ? `${characters.slice(0, 160).join('')}…` : text;
  }
  return undefined;
}

/** Map one shared canonical snapshot to the existing Hosted UI view models. */
export function projectConversationStreamForHostedUi(
  result: ConversationStreamResult,
): HostedConversationProjection {
  const presentation = result.presentation;
  const textById = new Map(presentation.textItems.map((entry) => [entry.id, entry]));
  const toolIds = new Set(presentation.toolItems.map((entry) => entry.itemId));
  const approvalIds = new Set(presentation.approvalItems.map((entry) => entry.itemId));
  const structuredInputIds = new Set(
    presentation.structuredInputItems.map((entry) => entry.itemId),
  );
  const a2uiIds = new Set(presentation.a2uiItems.map((entry) => entry.itemId));
  const artifactById = new Map(presentation.artifacts.map((entry) => [entry.id, entry]));
  const fallbackById = new Map(presentation.fallbacks.map((entry) => [entry.id, entry]));
  const messages: Message[] = [];
  const interactions: Interaction[] = [];

  // The shared presentation is the only place allowed to combine related
  // native items (for example tool_call and tool_result by callId). Iterating
  // raw state here would reintroduce duplicate cards in Hosted UI.
  for (const entry of presentation.timeline) {
    const { item } = entry;
    if (item.kind === 'agent') {
      if (!entry.children) { messages.push(fallbackMessage(item, 'Remote agent', String(item.payload.status || 'submitted'))); continue; }
      const childResult = {...result, presentation:{...presentation, timeline:entry.children || []}};
      const children = projectConversationStreamForHostedUi(childResult);
      messages.push({
        ...messageBase(item),
        role: 'model',
        content: '',
        agentBlock: {
          item,
          messages: children.messages,
          summary: latestPublicAgentSummary(entry.children || []),
        },
        status: item.payload.status === 'cancelled' ? 'cancelled' : messageBase(item).status,
      });
      interactions.push(...children.interactions);
      continue;
    }
    if (textById.has(item.itemId)) {
      messages.push(textMessage(item));
      continue;
    }
    if (toolIds.has(item.itemId)) {
      messages.push(toolMessage(item));
      continue;
    }
    if (approvalIds.has(item.itemId) || structuredInputIds.has(item.itemId)) {
      const interaction = interactionFromItem(item);
      if (interaction) {
        interactions.push(interaction);
        messages.push(approvalMessage(item, interaction));
      } else {
        messages.push(fallbackMessage(
          item,
          'Interaction unavailable',
          'The server did not provide a durable interaction revision; this card is read-only.',
        ));
      }
      continue;
    }
    if (a2uiIds.has(item.itemId)) {
      const message = a2uiMessage(item);
      messages.push(message || fallbackMessage(
        item,
        'Unsupported content',
        'A2UI payload is not a valid passive operation list.',
      ));
      continue;
    }
    const artifact = artifactById.get(item.itemId);
    if (artifact) {
      messages.push(artifact.status === 'pending'
        ? {
            ...messageBase(item),
            role: 'model',
            content: artifact.name,
            attachments: [{
              name: artifact.name,
              type: artifact.mimeType,
              url: '',
              artifactId: artifact.artifactId,
              itemId: artifact.itemId,
              runId: artifact.runId,
              sizeBytes: artifact.sizeBytes,
              status: 'pending',
            }],
          }
        : artifact.status === 'ready' && artifact.uri
        ? {
            ...messageBase(item),
            role: 'model',
            content: artifact.name,
            attachments: [{
              name: artifact.name,
              type: artifact.mimeType,
              url: artifact.uri,
              artifactId: artifact.artifactId,
              itemId: artifact.itemId,
              runId: artifact.runId,
              sizeBytes: artifact.sizeBytes,
              status: artifact.status,
            }],
          }
        : fallbackMessage(
              item,
            'Artifact unavailable',
            artifact.status === 'failed'
              ? 'The artifact failed to generate or its URI is not a safe HTTP(S) link.'
              : 'The artifact URI is not a safe HTTP(S) link.',
          ));
      continue;
    }
    const fallback = fallbackById.get(item.itemId);
    if (fallback) {
      const cancelled = item.kind === 'error'
        && ['cancelled', 'canceled'].includes(String(item.payload.status || '').toLowerCase());
      if (cancelled) continue;
      messages.push(fallbackMessage(
        item,
        fallback.title,
        fallback.detail,
        fallback.failed,
      ));
    }
  }

  return { messages, interactions };
}

/**
 * Replace this run's transcript projection. Once a run has canonical items,
 * the durable legacy read model for the same run is a replay source, not a
 * second presentation owner. Other runs/transports remain untouched; equal
 * text from distinct canonical item IDs is never merged.
 */
export function mergeConversationRunMessages(
  previous: Message[],
  result: ConversationStreamResult,
  optimisticMessageId?: string,
): Message[] {
  const projected = projectConversationStreamForHostedUi(result).messages;
  // Hidden progress is not a transcript replacement.
  if (!projected.length) return previous;
  const cleanPrevious = previous.filter(message => message.eventType !== 'optimistic_assistant_placeholder');
  const belongsToRun = (message: Message) => (
    message.runId === result.runId
    || message.invocationId === result.runId
  );
  const runIndex = cleanPrevious.findIndex(belongsToRun);
  // Use the submitted input identity. A later queued input is not part of this
  // run, even when it is the most recent optimistic message in the timeline.
  const inputIndex = optimisticMessageId
    ? cleanPrevious.findIndex(message => message.id === optimisticMessageId)
    : runIndex < 0
      ? cleanPrevious.findLastIndex(message => message.role === 'user' && message.eventType === 'optimistic_user_message')
      : cleanPrevious.findIndex(message => message.role === 'user' && belongsToRun(message));
  const input = cleanPrevious[inputIndex];
  const retained = cleanPrevious.filter((message, index) => index !== inputIndex && !belongsToRun(message));
  const positions = [inputIndex, runIndex].filter(index => index >= 0);
  const insertionIndex = positions.length ? Math.min(...positions) : retained.length;
  const preserveInput = input && !projected.some(message => message.role === 'user')
    ? [{ ...input, invocationId: result.runId, eventType: undefined }]
    : [];
  return [
    ...retained.slice(0, insertionIndex),
    ...preserveInput,
    ...projected,
    ...retained.slice(insertionIndex),
  ];
}
