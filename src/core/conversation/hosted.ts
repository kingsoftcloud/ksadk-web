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
    return { ...messageBase(item), role: 'user', content: text };
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
  const toolName = nonEmptyString(item.payload.tool) || 'Tool';
  const args = displayValue(item.payload.args);
  const output = Object.prototype.hasOwnProperty.call(item.payload, 'output')
    ? displayValue(item.payload.output)
    : undefined;
  const failed = item.lifecycle === 'failed' || item.payload.isError === true;
  const status = failed
    ? 'error' as const
    : item.lifecycle === 'completed'
      ? 'completed' as const
      : 'running' as const;
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
    }],
    tools: {
      [toolName]: { name: toolName, args, output, status },
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
    extensions: { conversation_item_id: item.itemId },
  };
}

function approvalMessage(item: ConversationItem, interaction: Interaction): Message {
  const toolName = nonEmptyString(item.payload.kind) || 'approval';
  const args = displayValue(item.payload.detail);
  const approvalStatus = interaction.status === 'resolved'
    ? interaction.outcome === 'rejected' ? 'rejected' as const : 'approved' as const
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

  for (const item of result.state.items) {
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
      messages.push(artifact.uri
        ? {
            ...messageBase(item),
            role: 'model',
            content: artifact.name,
            attachments: [{
              name: artifact.name,
              type: artifact.mimeType,
              url: artifact.uri,
            }],
          }
        : fallbackMessage(
            item,
            'Artifact unavailable',
            'The artifact URI is not a safe HTTP(S) link.',
          ));
      continue;
    }
    const fallback = fallbackById.get(item.itemId);
    if (fallback) {
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
 * Replace only this run's canonical projection. Other transports and previous
 * turns remain untouched; equal text from distinct item IDs is never merged.
 */
export function mergeConversationRunMessages(
  previous: Message[],
  result: ConversationStreamResult,
): Message[] {
  const projected = projectConversationStreamForHostedUi(result).messages;
  const belongsToRun = (message: Message) => (
    message.eventType === EVENT_TYPE && message.runId === result.runId
  );
  const insertionIndex = previous.findIndex(belongsToRun);
  const retained = previous.filter((message) => !belongsToRun(message));
  const index = insertionIndex < 0 ? retained.length : insertionIndex;
  return [
    ...retained.slice(0, index),
    ...projected,
    ...retained.slice(index),
  ];
}
