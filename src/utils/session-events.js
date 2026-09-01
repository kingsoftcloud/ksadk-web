import {
  createResponsesStreamState,
  normalizeResponsesStreamEvent,
} from './responses-stream.js';
import { isFailedToolOutput } from './tool-display.js';
import {
  RuntimeItemReducer,
  sessionEventToItemOperation,
} from '../core/stream/runtime-items.ts';

// Identity-aware (schema v2) ingress. Canonical events carry Metadata.RuntimeItem;
// legacy assistant events use the synthesized `${invocationId}:legacy-assistant`
// identity. No identity is inferred from previous messages or body text.
export {
  RuntimeItemReducer,
  sessionEventToItemOperation,
  legacyAssistantIdentity,
  projectRuntimeItems,
} from '../core/stream/runtime-items.ts';

/**
 * Reduce a list of session events into an identity-aware item snapshot.
 * Canonical `Metadata.RuntimeItem` events keep their full identity; legacy
 * `assistant_stream_snapshot`/`assistant_message` collapse onto the synthesized
 * per-invocation assistant item (snapshot -> replace, message -> complete).
 */
export function buildRuntimeItemsFromSessionEvents(events = []) {
  const reducer = new RuntimeItemReducer();
  for (const event of Array.isArray(events) ? events : []) {
    const operation = sessionEventToItemOperation(event);
    if (operation) {
      reducer.apply(operation);
    }
  }
  return reducer.snapshot();
}

/**
 * @typedef {import('../components/chat/types.js').Message} Message
 */

const RUN_TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'error',
  'cancelled',
  'canceled',
  'aborted',
  'interrupted',
  'resume_failed',
]);

const TOOL_EVENT_TYPES = new Set([
  'tool_call',
  'tool_result',
  'stage_tool_call',
  'stage_tool_result',
]);

const RUNTIME_RUN_STATUS_BY_EVENT_TYPE = {
  'run.started': 'in_progress',
  'run.progress': 'in_progress',
  'run.interrupted': 'interrupted',
  'run.completed': 'completed',
  'run.failed': 'failed',
  'run.canceled': 'cancelled',
};

function runtimePayload(event) {
  const payload = event?.Content?.payload;
  return payload && typeof payload === 'object' ? payload : {};
}

function mergeRuntimeDelta(previous, incoming) {
  const left = String(previous || '');
  const right = String(incoming || '');
  if (!left) return right;
  if (!right || left.endsWith(right)) return left;
  if (right.startsWith(left)) return right;
  return `${left}${right}`;
}

function normalizeRuntimeSessionEvent(event) {
  const eventType = String(event?.EventType || '');
  const payload = runtimePayload(event);
  if (RUNTIME_RUN_STATUS_BY_EVENT_TYPE[eventType]) {
    return {
      ...event,
      EventType: 'run_status',
      Content: {
        status: String(payload.status || RUNTIME_RUN_STATUS_BY_EVENT_TYPE[eventType]),
        ...(payload.detail ? { detail: String(payload.detail) } : {}),
      },
    };
  }
  if (eventType === 'reasoning.delta' || eventType === 'reasoning.completed') {
    return {
      ...event,
      EventType: 'reasoning',
      Content: { role: 'model', parts: [{ text: String(payload.text || '') }] },
    };
  }
  if (eventType === 'tool.call.begin') {
    return {
      ...event,
      EventType: 'tool_call',
      Metadata: {
        ...(event.Metadata || {}),
        tool_name: payload.name,
        tool_args: payload.args,
        tool_call_id: payload.call_id,
      },
      Content: { role: 'model', parts: [] },
    };
  }
  if (eventType === 'tool.call.end') {
    return {
      ...event,
      EventType: 'tool_result',
      Metadata: {
        ...(event.Metadata || {}),
        tool_name: payload.name,
        tool_output: payload.error || payload.result,
        tool_call_id: payload.call_id,
      },
      Content: { role: 'model', parts: [] },
    };
  }
  return event;
}

function normalizeRuntimeSessionEvents(events) {
  const normalized = [];
  const textByInvocation = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const eventType = String(event?.EventType || '');
    if (eventType === 'text.delta' || eventType === 'text.completed') {
      const invocationId = String(event?.InvocationId || '').trim();
      if (!invocationId) {
        continue;
      }
      const previous = textByInvocation.get(invocationId);
      textByInvocation.set(invocationId, {
        event,
        text: mergeRuntimeDelta(previous?.text, runtimePayload(event).text),
      });
      continue;
    }
    normalized.push(normalizeRuntimeSessionEvent(event));
  }
  for (const { event, text } of textByInvocation.values()) {
    normalized.push({
      ...event,
      EventType: 'assistant_stream_snapshot',
      Content: { role: 'model', parts: [{ text }] },
      Metadata: {
        ...(event.Metadata || {}),
        stream_snapshot: true,
      },
    });
  }
  return normalized.sort((left, right) => eventOrderValue(left) - eventOrderValue(right));
}

export function sessionEventRunStatus(event) {
  const eventType = String(event?.EventType || '').trim();
  const payload = runtimePayload(event);
  return String(
    event?.Content?.status
      || payload.status
      || RUNTIME_RUN_STATUS_BY_EVENT_TYPE[eventType]
      || '',
  ).trim().toLowerCase();
}

function textFromUnknown(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && typeof item.text === 'string') {
          return item.text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

function attachmentContentUrl(fileUri) {
  const normalized = String(fileUri || '').trim();
  if (!normalized) {
    return '';
  }
  return `/agentengine/api/v1/AttachmentContent?FileUri=${encodeURIComponent(normalized)}`;
}

function mimeTypeFromDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+)/);
  return match?.[1] || '';
}

function mimeTypesMatch(left, right) {
  const normalizedLeft = String(left || '').trim();
  const normalizedRight = String(right || '').trim();
  if (!normalizedLeft || !normalizedRight) {
    return true;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }
  if (normalizedLeft.endsWith('/*')) {
    return normalizedRight.startsWith(normalizedLeft.slice(0, -1));
  }
  if (normalizedRight.endsWith('/*')) {
    return normalizedLeft.startsWith(normalizedRight.slice(0, -1));
  }
  return false;
}

export function parseMessageContent(event) {
  const parts = event?.Content?.parts || [];
  const textSegments = [];
  const attachmentsByKey = new Map();

  const pushAttachment = (attachment) => {
    const key = `${attachment.fileUri || attachment.url || attachment.name}|${attachment.type}`;
    if (!attachmentsByKey.has(key)) {
      attachmentsByKey.set(key, attachment);
    }
  };

  for (const part of parts) {
    if (part?.type === 'input_text' || part?.text) {
      textSegments.push(part.text || '');
      continue;
    }
    if (part?.type === 'input_file' && part.inlineData) {
      pushAttachment({
        name: part.inlineData.displayName || 'attachment',
        url: `data:${part.inlineData.mimeType || 'application/octet-stream'};base64,${part.inlineData.data}`,
        type: part.inlineData.mimeType || 'application/octet-stream',
      });
      continue;
    }
    if (part?.type === 'input_file' && typeof part.file_data === 'string' && part.file_data) {
      pushAttachment({
        name: part.filename || part.displayName || part.display_name || 'attachment',
        url: `data:${part.mime_type || part.mimeType || 'application/octet-stream'};base64,${part.file_data}`,
        type: part.mime_type || part.mimeType || 'application/octet-stream',
      });
      continue;
    }
    if (part?.type === 'input_file' && typeof part.file_url === 'string' && part.file_url.trim()) {
      const fileUri = part.file_url.trim();
      pushAttachment({
        name: part.filename || part.displayName || part.display_name || 'attachment',
        url: attachmentContentUrl(fileUri),
        type: part.mime_type || part.mimeType || 'application/octet-stream',
        fileUri,
      });
      continue;
    }
    if (part?.type === 'input_image' || part?.type === 'image_url') {
      const imageUrl = typeof part.image_url === 'string'
        ? part.image_url
        : part.image_url?.url;
      if (imageUrl) {
        pushAttachment({
          name: part.filename || part.displayName || part.display_name || 'uploaded_image',
          url: imageUrl,
          type: part.mime_type || part.mimeType || mimeTypeFromDataUrl(imageUrl) || 'image/*',
        });
      }
      continue;
    }
    if (part?.type === 'input_file' && part.fileData) {
      const fileUri = String(part.fileData.fileUri || '').trim();
      pushAttachment({
        name: part.fileData.displayName || 'attachment',
        url: attachmentContentUrl(fileUri),
        type: part.fileData.mimeType || 'application/octet-stream',
        fileUri,
      });
    }
  }

  const metadataAttachments = Array.isArray(event?.Metadata?.attachments)
    ? event.Metadata.attachments
    : [];

  for (const attachment of metadataAttachments) {
    const fileUri = String(attachment.file_uri || '').trim();
    const metadataAttachment = {
      name: attachment.display_name || 'attachment',
      url: attachmentContentUrl(fileUri),
      type: attachment.mime_type || 'application/octet-stream',
      fileUri,
    };
    const isEmptyMetadataReference = !metadataAttachment.url && !metadataAttachment.fileUri;
    const isAlreadyRepresentedByContent = isEmptyMetadataReference
      && Array.from(attachmentsByKey.values()).some((existing) => (
        existing.name === metadataAttachment.name
        && mimeTypesMatch(existing.type, metadataAttachment.type)
        && (existing.url || existing.fileUri)
      ));
    if (!isAlreadyRepresentedByContent) {
      pushAttachment(metadataAttachment);
    }
  }

  const attachments = Array.from(attachmentsByKey.values());
  return {
    text: textSegments.join(''),
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}

function buildResponsesOutputEnhancements(event) {
  const responsesOutput = event?.Metadata?.responses_output;
  if (!Array.isArray(responsesOutput)) {
    return {};
  }

  const state = createResponsesStreamState();
  const actions = normalizeResponsesStreamEvent({
    eventName: 'response.completed',
    data: {
      response: {
        id: String(event.Metadata?.response_id || ''),
        output: responsesOutput,
      },
    },
    state,
  });
  let reasoning = '';
  const tools = {};

  for (const action of actions) {
    if (action.type === 'reasoning_delta') {
      reasoning += action.text;
      continue;
    }
    if (action.type === 'tool_upsert') {
      tools[action.name] = {
        ...(tools[action.name] || { name: action.name, args: '' }),
        name: action.name,
        args: action.args,
        status: action.status,
        ...(action.approvalRequestId ? { approvalRequestId: action.approvalRequestId } : {}),
        ...(action.previousResponseId ? { previousResponseId: action.previousResponseId } : {}),
        ...(action.serverLabel ? { serverLabel: action.serverLabel } : {}),
        ...(action.approvalRequestId ? { approvalStatus: 'pending' } : {}),
      };
      continue;
    }
    if (action.type === 'tool_result') {
      tools[action.name] = {
        ...(tools[action.name] || { name: action.name, args: '' }),
        name: action.name,
        output: action.output,
        status: isFailedToolOutput(action.output) ? 'error' : 'completed',
      };
    }
  }

  return {
    ...(reasoning ? { reasoning } : {}),
    ...(Object.keys(tools).length > 0 ? { tools } : {}),
  };
}

function buildCompactionLabel(trigger, status, historical) {
  if (status === 'running') {
    return trigger === 'prompt_too_long'
      ? '检测到上下文过长，正在自动压缩历史后重试'
      : '正在自动压缩上下文';
  }
  if (historical) {
    return trigger === 'prompt_too_long'
      ? '上下文过长，系统已自动压缩历史并重试'
      : '系统已自动压缩较早的对话上下文';
  }
  if (status === 'failed') {
    return '自动压缩上下文未完成';
  }
  return trigger === 'prompt_too_long'
    ? '已完成上下文压缩，并继续当前回复'
    : '已完成上下文压缩';
}

function assistantOutputDedupeKey(invocationId, message) {
  if (message?.itemId) {
    return [
      'runtime-item',
      message.runId || invocationId,
      message.scopeId || invocationId,
      message.itemId,
    ].join('\u0000');
  }
  return [
    invocationId,
    message.content || '',
    message.reasoning || '',
  ].join('\u0000');
}

function assistantEventProjectionKey(event) {
  const invocationId = String(event?.InvocationId || '').trim();
  const runtimeItem = event?.Metadata?.RuntimeItem;
  if (runtimeItem?.ItemId) {
    return [
      'runtime-item',
      runtimeItem.RunId || invocationId,
      runtimeItem.ScopeId || invocationId,
      runtimeItem.ItemId,
    ].join('\u0000');
  }
  return invocationId;
}

function runtimeIdentityFromEvent(event) {
  const runtimeItem = event?.Metadata?.RuntimeItem;
  if (!runtimeItem?.ItemId) return null;
  return {
    id: `runtime:${runtimeItem.RunId || event.InvocationId || 'run'}:${runtimeItem.ScopeId || event.InvocationId || 'scope'}:${runtimeItem.ItemId}`,
    runId: String(runtimeItem.RunId || event.InvocationId || ''),
    scopeId: String(runtimeItem.ScopeId || event.InvocationId || ''),
    itemId: String(runtimeItem.ItemId),
    partId: runtimeItem.PartId ? String(runtimeItem.PartId) : undefined,
  };
}

function isResponsesMirrorEvent(event) {
  return event?.Metadata?.responses_mirror === true
    || String(event?.Metadata?.responses_mirror || '').trim().toLowerCase() === 'true';
}

function userMessageDedupeKey(event) {
  if (event?.EventType !== 'user_message') {
    return '';
  }
  const parsed = parseMessageContent(event);
  const attachments = (parsed.attachments || [])
    .map((attachment) => [
      attachment.name || '',
      attachment.fileUri || '',
      attachment.url || '',
      attachment.type || '',
    ].join('\u0001'))
    .sort()
    .join('\u0002');
  return [
    String(parsed.text || '').trim(),
    attachments,
  ].join('\u0000');
}

function isAssistantStreamSnapshotEvent(event) {
  return event?.EventType === 'assistant_stream_snapshot';
}

function eventOrderValue(event) {
  const seqId = Number(event?.SeqId || 0);
  if (Number.isFinite(seqId) && seqId > 0) {
    return seqId;
  }
  const timestamp = Number(event?.Timestamp || 0);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function stringifyToolPayload(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    return '';
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toolMessageFromSessionEvent(event) {
  const eventType = String(event?.EventType || '');
  if (!TOOL_EVENT_TYPES.has(eventType)) {
    return null;
  }
  const name = String(
    event.Metadata?.tool_name
      || event.Metadata?.name
      || event.Metadata?.function_name
      || textFromUnknown(event.Content?.parts)
      || 'tool',
  ).trim() || 'tool';
  const existing = {
    name,
    args: '',
    status: 'running',
  };
  const tool =
    eventType === 'tool_result' || eventType === 'stage_tool_result'
      ? (() => {
          const output = stringifyToolPayload(
            event.Metadata?.tool_output
              ?? event.Metadata?.output
              ?? event.Metadata?.result
              ?? textFromUnknown(event.Content?.parts),
          );
          return {
            ...existing,
            output,
            status: isFailedToolOutput(output) ? 'error' : 'completed',
          };
        })()
      : {
          ...existing,
          args: stringifyToolPayload(
            event.Metadata?.tool_args
              ?? event.Metadata?.arguments
              ?? event.Metadata?.args
              ?? {},
          ),
        };
  const runtimeIdentity = runtimeIdentityFromEvent(event);
  return {
    id: runtimeIdentity?.id || event.EventId || String(Date.now() + Math.random()),
    role: 'model',
    content: '',
    timestamp: event.Timestamp || Date.now(),
    eventType,
    ...(runtimeIdentity || {}),
    tools: {
      [name]: tool,
    },
  };
}

function mergeToolMaps(first = {}, second = {}) {
  const merged = { ...(first || {}) };
  for (const [name, tool] of Object.entries(second || {})) {
    merged[name] = {
      ...(merged[name] || {}),
      ...(tool || {}),
      name,
      args: tool?.args || merged[name]?.args || '',
    };
  }
  return merged;
}

function settleToolMapsForRunStatus(tools = {}, runStatus = '') {
  const normalized = String(runStatus || '').trim().toLowerCase();
  const nextStatus = normalized === 'completed'
    ? 'completed'
    : RUN_TERMINAL_STATUSES.has(normalized)
      ? 'error'
      : '';
  if (!nextStatus) {
    return tools;
  }

  let changed = false;
  const settled = {};
  for (const [name, tool] of Object.entries(tools || {})) {
    if (tool?.status === 'running') {
      changed = true;
      settled[name] = { ...tool, status: nextStatus };
    } else {
      settled[name] = tool;
    }
  }
  return changed ? settled : tools;
}

function mergeMessageMetadata(existing, incoming) {
  return {
    ...existing,
    reasoning: mergeReasoningText(existing.reasoning, incoming.reasoning),
    tools: mergeToolMaps(existing.tools, incoming.tools),
    eventId: incoming.eventId || existing.eventId,
    responseId: incoming.responseId || existing.responseId,
    traceId: incoming.traceId || existing.traceId,
    rootSpanId: incoming.rootSpanId || existing.rootSpanId,
    timestamp: Math.max(Number(existing.timestamp || 0), Number(incoming.timestamp || 0)) || incoming.timestamp || existing.timestamp,
    id: incoming.responseId || incoming.reasoning || incoming.tools ? incoming.id : existing.id,
  };
}

function mergeReasoningText(first = '', second = '') {
  const left = String(first || '');
  const right = String(second || '');
  if (!left) return right;
  if (!right) return left;
  if (left.endsWith(right)) return left;
  if (right.startsWith(left)) return right;
  return `${left}${right}`;
}

/**
 * @param {{
 *   id: string;
 *   timestamp: number;
 *   status?: Message['status'];
 *   trigger?: string;
 *   compactedUntilSeqId?: number;
 *   summary?: string;
 *   historical?: boolean;
 * }} options
 * @returns {Message}
 */
export function buildCompactionMessage(options) {
  return {
    id: options.id,
    role: 'system',
    eventType: 'context_checkpoint',
    status: options.status,
    trigger: options.trigger,
    compactedUntilSeqId: options.compactedUntilSeqId,
    summary: options.summary,
    historical: options.historical,
    timestamp: options.timestamp,
    content: buildCompactionLabel(options.trigger, options.status, options.historical),
  };
}

/**
 * @param {import('../types/session-events.js').SessionEventRecord} event
 * @returns {Message | null}
 */
export function buildMessageFromSessionEvent(event) {
  const eventType = event?.EventType || '';
  const runtimeIdentity = runtimeIdentityFromEvent(event);
  if (eventType === 'run_status') {
    if (event.Content?.status === 'failed') {
      return {
        id: event.EventId || String(Date.now() + Math.random()),
        role: 'system',
        content: event.Content?.detail || '本轮运行失败。',
        eventType,
        status: 'failed',
        timestamp: event.Timestamp || Date.now(),
      };
    }
    if (event.Content?.status === 'cancelled') {
      return {
        id: event.EventId || String(Date.now() + Math.random()),
        role: 'system',
        content: event.Content?.detail || '本轮输出已停止。',
        eventType,
        status: 'cancelled',
        timestamp: event.Timestamp || Date.now(),
      };
    }
    return null;
  }

  if (eventType === 'context_checkpoint') {
    const parsed = parseMessageContent(event);
    return buildCompactionMessage({
      id: event.EventId || String(Date.now() + Math.random()),
      timestamp: event.Timestamp || Date.now(),
      status: 'completed',
      trigger: String(event.Metadata?.trigger || 'auto'),
      compactedUntilSeqId: Number(event.Metadata?.compacted_until_seq_id || 0) || undefined,
      summary: parsed.text || undefined,
      historical: true,
    });
  }

  if (eventType === 'reasoning') {
    const parsed = parseMessageContent(event);
    const reasoning = parsed.text || textFromUnknown(event.Metadata?.reasoning);
    return reasoning
      ? {
          id: runtimeIdentity?.id || event.EventId || String(Date.now() + Math.random()),
          role: 'model',
          content: '',
          reasoning,
          timestamp: event.Timestamp || Date.now(),
          eventType,
          ...(runtimeIdentity || {}),
        }
      : null;
  }

  if (TOOL_EVENT_TYPES.has(eventType)) {
    return toolMessageFromSessionEvent(event);
  }

  if (
    eventType !== 'user_message'
    && eventType !== 'assistant_message'
    && eventType !== 'assistant_stream_snapshot'
  ) {
    return null;
  }

  const parsed = parseMessageContent(event);
  const responsesEnhancements =
    eventType === 'assistant_message' ? buildResponsesOutputEnhancements(event) : {};
  if (
    !parsed.text
    && !parsed.attachments?.length
    && !responsesEnhancements.reasoning
    && !responsesEnhancements.tools
  ) {
    return null;
  }

  const responseId = String(event.Metadata?.response_id || event.Metadata?.ResponseId || '').trim();
  const traceId = String(event.Metadata?.trace_id || event.Metadata?.TraceId || '').trim();
  const rootSpanId = String(
    event.Metadata?.root_span_id || event.Metadata?.rootSpanId || event.Metadata?.RootSpanId || '',
  ).trim();

  return {
    id: runtimeIdentity?.id || event.EventId || String(Date.now() + Math.random()),
    role: eventType === 'user_message' ? 'user' : 'model',
    content: parsed.text,
    timestamp: event.Timestamp || Date.now(),
    eventType,
    eventId: event.EventId || undefined,
    responseId: responseId || undefined,
    traceId: traceId || undefined,
    rootSpanId: rootSpanId || undefined,
    attachments: parsed.attachments,
    ...(runtimeIdentity || {}),
    ...responsesEnhancements,
  };
}

/**
 * @param {import('../types/session-events.js').SessionEventRecord[]} [events]
 * @returns {Message[]}
 */
export function buildMessagesFromSessionEvents(events = []) {
  const latestRunStatusByInvocation = new Map();
  const latestRunStatusEventByInvocation = new Map();
  const outputByInvocation = new Set();
  const userMessageByInvocation = new Set();
  const assistantOutputKeys = new Set();
  const seenEventIds = new Set();
  const normalizedEvents = normalizeRuntimeSessionEvents(events);
  const uniqueEvents = [];
  for (const event of normalizedEvents) {
    const eventId = String(event?.EventId || '').trim();
    if (eventId) {
      if (seenEventIds.has(eventId)) {
        continue;
      }
      seenEventIds.add(eventId);
    }
    uniqueEvents.push(event);
  }
  const canonicalUserMessageKeys = new Set();
  const finalAssistantKeys = new Set();
  const latestSnapshotByKey = new Map();
  for (const event of uniqueEvents) {
    if (event?.EventType !== 'user_message' || isResponsesMirrorEvent(event)) {
      if (event?.EventType === 'assistant_message') {
        const projectionKey = assistantEventProjectionKey(event);
        if (projectionKey) {
          finalAssistantKeys.add(projectionKey);
        }
      }
      if (isAssistantStreamSnapshotEvent(event)) {
        const projectionKey = assistantEventProjectionKey(event);
        if (projectionKey) {
          const existing = latestSnapshotByKey.get(projectionKey);
          if (!existing || eventOrderValue(event) >= eventOrderValue(existing)) {
            latestSnapshotByKey.set(projectionKey, event);
          }
        }
      }
      continue;
    }
    const key = userMessageDedupeKey(event);
    if (key) {
      canonicalUserMessageKeys.add(key);
    }
  }
  const replayEvents = uniqueEvents.filter((event) => {
    if (isAssistantStreamSnapshotEvent(event)) {
      const projectionKey = assistantEventProjectionKey(event);
      if (!projectionKey) {
        return true;
      }
      if (finalAssistantKeys.has(projectionKey)) {
        return false;
      }
      return latestSnapshotByKey.get(projectionKey) === event;
    }
    if (event?.EventType !== 'user_message' || !isResponsesMirrorEvent(event)) {
      return true;
    }
    const key = userMessageDedupeKey(event);
    return !key || !canonicalUserMessageKeys.has(key);
  });

  for (const event of replayEvents) {
    const invocationId = String(event.InvocationId || '').trim();
    if (invocationId && event.EventType === 'user_message') {
      userMessageByInvocation.add(invocationId);
    }
    if (
      invocationId &&
      ['assistant_message', 'assistant_stream_snapshot', 'reasoning', 'tool_call', 'tool_result', 'stage_tool_call', 'stage_tool_result'].includes(String(event.EventType || ''))
    ) {
      outputByInvocation.add(invocationId);
    }
    if (event.EventType !== 'run_status') {
      continue;
    }
    if (!invocationId) {
      continue;
    }
    latestRunStatusByInvocation.set(invocationId, String(event.Content?.status || '').trim());
    latestRunStatusEventByInvocation.set(invocationId, event);
  }

  /** @type {Array<Message & { invocationId?: string }>} */
  const messages = [];
  const responseIdToIndex = new Map();
  const runtimeItemToIndex = new Map();
  /** @type {(Message & { invocationId?: string }) | null} */
  let pendingReasoning = null;
  /** @type {Map<string, Message & { invocationId?: string }>} */
  const pendingToolsByInvocation = new Map();

  const pushMessage = (message) => {
    const runtimeItemKey = message?.itemId
      ? `${message.runId || message.invocationId || ''}\u0000${message.scopeId || message.invocationId || ''}\u0000${message.itemId}`
      : '';
    const runtimeItemIndex = runtimeItemKey ? runtimeItemToIndex.get(runtimeItemKey) : undefined;
    if (runtimeItemIndex !== undefined) {
      messages[runtimeItemIndex] = mergeMessageMetadata(messages[runtimeItemIndex], message);
      return;
    }
    const responseId = String(message?.responseId || '').trim();
    const existingIndex = responseId ? responseIdToIndex.get(responseId) : undefined;
    if (existingIndex !== undefined) {
      messages[existingIndex] = mergeMessageMetadata(messages[existingIndex], message);
      return;
    }
    if (responseId) {
      responseIdToIndex.set(responseId, messages.length);
    }
    if (runtimeItemKey) {
      runtimeItemToIndex.set(runtimeItemKey, messages.length);
    }
    messages.push(message);
  };

  const flushPendingReasoning = () => {
    if (pendingReasoning) {
      pushMessage(pendingReasoning);
      pendingReasoning = null;
    }
  };

  const takePendingTools = (invocationId) => {
    const normalizedInvocationId = String(invocationId || '').trim();
    if (!normalizedInvocationId) {
      return {};
    }
    const pendingTools = pendingToolsByInvocation.get(normalizedInvocationId);
    if (!pendingTools) {
      return {};
    }
    pendingToolsByInvocation.delete(normalizedInvocationId);
    return {
      tools: settleToolMapsForRunStatus(
        pendingTools.tools,
        latestRunStatusByInvocation.get(normalizedInvocationId),
      ),
    };
  };

  for (const event of replayEvents) {
    if (event.EventType === 'run_status') {
      continue;
    }
    const message = buildMessageFromSessionEvent(event);
    if (!message) {
      continue;
    }
    const eventInvocationId = String(event.InvocationId || '').trim();
    if (eventInvocationId) {
      message.invocationId = eventInvocationId;
    }
    if (TOOL_EVENT_TYPES.has(message.eventType)) {
      const invocationId = String(event.InvocationId || '').trim();
      if (message.itemId) {
        flushPendingReasoning();
        pushMessage(message);
        continue;
      }
      if (!invocationId) {
        flushPendingReasoning();
        pushMessage(message);
        continue;
      }
      const existing = pendingToolsByInvocation.get(invocationId);
      pendingToolsByInvocation.set(invocationId, {
        ...(existing || {
          id: message.id,
          role: 'model',
          content: '',
          timestamp: message.timestamp,
          invocationId,
        }),
        timestamp: Math.max(
          Number(existing?.timestamp || 0),
          Number(message.timestamp || 0),
        ),
        tools: mergeToolMaps(existing?.tools, message.tools),
      });
      continue;
    }
    if (message.eventType === 'reasoning') {
      const invocationId = String(event.InvocationId || '').trim();
      const runtimeOperation = String(event.Metadata?.RuntimeItem?.Operation || '').toLowerCase();
      const sameRuntimeItem = Boolean(
        message.itemId
        && pendingReasoning?.itemId === message.itemId
        && pendingReasoning?.runId === message.runId
        && pendingReasoning?.scopeId === message.scopeId,
      );
      const sameLegacyInvocation = Boolean(
        !message.itemId
        && !pendingReasoning?.itemId
        && invocationId
        && pendingReasoning?.invocationId === invocationId,
      );
      if (
        pendingReasoning &&
        (sameRuntimeItem || sameLegacyInvocation)
      ) {
        pendingReasoning.reasoning = runtimeOperation === 'replace' || runtimeOperation === 'completed'
          ? message.reasoning
          : `${pendingReasoning.reasoning || ''}${message.reasoning || ''}`;
        pendingReasoning.timestamp = message.timestamp;
        continue;
      }
      flushPendingReasoning();
      pendingReasoning = {
        ...message,
        ...(invocationId ? { invocationId } : {}),
      };
      continue;
    }
    const isAssistantOutputEvent =
      message.eventType === 'assistant_message'
      || message.eventType === 'assistant_stream_snapshot';
    if (isAssistantOutputEvent && pendingReasoning) {
      const invocationId = String(event.InvocationId || '').trim();
      const outputKey = assistantOutputDedupeKey(invocationId, message);
      if (message.eventType === 'assistant_message' && invocationId && assistantOutputKeys.has(outputKey)) {
        pendingReasoning = null;
        continue;
      }
      if (message.eventType === 'assistant_message' && invocationId) {
        assistantOutputKeys.add(outputKey);
      }
      pushMessage({
        ...message,
        ...takePendingTools(invocationId),
        reasoning: mergeReasoningText(pendingReasoning.reasoning, message.reasoning),
      });
      pendingReasoning = null;
      continue;
    }
    flushPendingReasoning();
    if (isAssistantOutputEvent) {
      const invocationId = String(event.InvocationId || '').trim();
      const outputKey = assistantOutputDedupeKey(invocationId, message);
      if (message.eventType === 'assistant_message' && invocationId && assistantOutputKeys.has(outputKey)) {
        continue;
      }
      if (message.eventType === 'assistant_message' && invocationId) {
        assistantOutputKeys.add(outputKey);
      }
      pushMessage({
        ...message,
        ...takePendingTools(invocationId),
      });
      continue;
    }
    pushMessage(message);
  }

  flushPendingReasoning();
  for (const [invocationId, pendingTools] of pendingToolsByInvocation.entries()) {
    pushMessage({
      ...pendingTools,
      tools: settleToolMapsForRunStatus(
        pendingTools.tools,
        latestRunStatusByInvocation.get(invocationId),
      ),
    });
  }
  for (const [invocationId, status] of latestRunStatusByInvocation.entries()) {
    if (
      status !== 'in_progress' ||
      outputByInvocation.has(invocationId) ||
      !userMessageByInvocation.has(invocationId)
    ) {
      continue;
    }
    const event = latestRunStatusEventByInvocation.get(invocationId) || {};
    pushMessage({
      id: `run-placeholder-${invocationId}`,
      role: 'model',
      content: '',
      status: 'running',
      eventType: 'run_status',
      timestamp: event.Timestamp || Date.now(),
    });
  }

  return messages;
}

export function mergeSessionEventRecords(baseEvents = [], incomingEvents = []) {
  const merged = [];
  const seenEventIds = new Set();
  for (const event of [...(Array.isArray(baseEvents) ? baseEvents : []), ...(Array.isArray(incomingEvents) ? incomingEvents : [])]) {
    const eventId = String(event?.EventId || '').trim();
    if (eventId) {
      if (seenEventIds.has(eventId)) {
        continue;
      }
      seenEventIds.add(eventId);
    }
    merged.push(event);
  }
  return merged.sort((left, right) => {
    const leftSeqId = Number(left?.SeqId || 0);
    const rightSeqId = Number(right?.SeqId || 0);
    if (Number.isFinite(leftSeqId) && Number.isFinite(rightSeqId) && leftSeqId !== rightSeqId) {
      return leftSeqId - rightSeqId;
    }
    return Number(left?.Timestamp || 0) - Number(right?.Timestamp || 0);
  });
}

export function maxSeqIdFromEvents(events = []) {
  return (Array.isArray(events) ? events : []).reduce((maxSeqId, event) => {
    const seqId = Number(event.SeqId || 0);
    return Number.isFinite(seqId) ? Math.max(maxSeqId, seqId) : maxSeqId;
  }, 0);
}

export function eventHasTerminalRunStatus(event) {
  return RUN_TERMINAL_STATUSES.has(sessionEventRunStatus(event));
}
