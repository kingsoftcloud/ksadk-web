const TOOL_STATUS_MAP = {
  running: 'running',
  completed: 'completed',
  failed: 'error',
  paused: 'paused',
  unknown: 'unknown',
  approved: 'completed',
  denied: 'completed',
  rejected: 'completed',
  cancelled: 'completed',
  expired: 'completed',
};

const APPROVAL_STATUS_MAP = {
  pending: 'pending',
  paused: 'pending',
  approved: 'approved',
  denied: 'rejected',
  rejected: 'rejected',
  cancelled: 'cancelled',
  expired: 'cancelled',
};

function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 100_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const numeric = Number(value.trim());
    if (value.trim() && Number.isFinite(numeric)) {
      return numeric > 0 && numeric < 100_000_000_000 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function extractContentText(content) {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (Array.isArray(content.parts)) {
      return content.parts
        .map((part) =>
          part && typeof part === 'object' && typeof part.text === 'string' ? part.text : '',
        )
        .join('');
    }
  }
  return '';
}

function mapToolEvents(toolEvents) {
  const tools = {};
  const nameCounts = new Map();
  for (const te of toolEvents ?? []) {
    if (!te?.Name) continue;
    nameCounts.set(te.Name, (nameCounts.get(te.Name) || 0) + 1);
  }
  for (const te of toolEvents ?? []) {
    if (!te?.Name) continue;
    const status = TOOL_STATUS_MAP[String(te.Status ?? 'completed').toLowerCase()] ?? 'completed';
    const entry = {
      name: te.Name,
      args: te.Args === undefined ? '' : typeof te.Args === 'string' ? te.Args : JSON.stringify(te.Args),
      status,
    };
    if (te.Result !== undefined) {
      entry.output = typeof te.Result === 'string' ? te.Result : JSON.stringify(te.Result);
    }
    if (te.ApprovalRequestId) {
      entry.approvalRequestId = te.ApprovalRequestId;
      entry.approvalStatus = APPROVAL_STATUS_MAP[String(te.ApprovalStatus ?? te.Status ?? 'paused').toLowerCase()];
      entry.approvalProtocol = String(te.Protocol ?? '').toLowerCase() === 'ag-ui'
        ? 'ag-ui'
        : 'responses';
      if (te.ApprovalMessage) entry.approvalMessage = String(te.ApprovalMessage);
      if (te.ApprovalLevel) entry.approvalLevel = String(te.ApprovalLevel);
    }
    if (te.ToolCallId) {
      entry.callId = te.ToolCallId;
      entry.previousResponseId = te.ToolCallId;
    }
    // 同名多次时按调用/审批 ID 分键；单工具保持 name 键兼容。
    const key = nameCounts.get(te.Name) > 1
      ? te.ToolCallId || te.ApprovalRequestId || te.Name : te.Name;
    tools[key] = entry;
  }
  return tools;
}

function mapAttachments(attachments) {
  if (!Array.isArray(attachments)) return undefined;
  return attachments.map((att) => ({
    name: att.name || '',
    url: att.url || '',
    type: att.mime || '',
    fileUri: att.file_uri,
  }));
}

function stringifyBlockValue(value) {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Map KsADK's persisted, ordered stream timeline to the chat block model. */
function mapPersistedBlocks(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) return undefined;
  return blocks.flatMap((block, index) => {
    const type = String(block?.Type || '').toLowerCase();
    const seqId = block?.SeqId ?? index;
    if (type === 'thinking' || type === 'text') {
      const content = String(block?.Content || '');
      if (!content) return [];
      return [{
        id: `history-${type}-${seqId}`,
        type,
        content,
        status: 'done',
      }];
    }
    if (type !== 'tool') return [];
    const status = TOOL_STATUS_MAP[String(block?.Status || 'completed').toLowerCase()] ?? 'completed';
    return [{
      id: `history-tool-${seqId}`,
      type: 'tool',
      toolName: String(block?.Name || 'tool'),
      args: stringifyBlockValue(block?.Args),
      ...(block?.Result !== undefined ? { output: stringifyBlockValue(block.Result) } : {}),
      status,
      ...(block?.ToolCallId ? { extra: { callId: String(block.ToolCallId), previousResponseId: String(block.ToolCallId) } } : {}),
    }];
  });
}

export function mapBackendMessage(msg) {
  const role = msg.Role === 'assistant' ? 'model' : (msg.Role || 'user');
  const tools = msg.ToolEvents?.length ? mapToolEvents(msg.ToolEvents) : undefined;
  const attachments = mapAttachments(msg.Attachments);
  const persistedBlocks = mapPersistedBlocks(msg.Blocks);
  const reasoning = msg.Reasoning?.length
    ? msg.Reasoning.map((r) => r.text).join('')
    : undefined;
  const result = {
    id: msg.MessageId || `msg-${msg.SeqId ?? Math.random().toString(36).slice(2)}`,
    role,
    content: extractContentText(msg.Content),
    timestamp: parseTimestamp(msg.Timestamp),
    ...(Number.isSafeInteger(msg.SeqId) && msg.SeqId > 0 ? { historyOrder: { seq: msg.SeqId,
      ...(Number.isSafeInteger(msg.StartSeqId) && msg.StartSeqId > 0 ? { group: msg.StartSeqId } : {}),
    } } : {}),
    eventType: role === 'user' ? 'user_message' : 'assistant_message',
    reasoning,
    tools,
    attachments,
  };
  // 历史消息重建交错 blocks(思考→工具→正文),刷新后也走 ProcessingBlocksView,
  // 不回退到旧 reasoning+tools+content 散装渲染。
  if (role === 'model') {
    result.blocks = persistedBlocks ?? buildBlocksFromHistory({ reasoning, tools, content: result.content });
  }
  // 反馈控件需要 responseId/eventId/traceId/rootSpanId(后端从 event Metadata 投出)
  if (msg.MessageId) result.eventId = msg.MessageId;
  if (msg.InvocationId) result.invocationId = msg.InvocationId;
  if (msg.ScopeId) result.scopeId = msg.ScopeId;
  if (msg.ResponseId) result.responseId = msg.ResponseId;
  if (msg.TraceId) result.traceId = msg.TraceId;
  if (msg.RootSpanId) result.rootSpanId = msg.RootSpanId;
  return result;
}

function mapBackendActivities(msg) {
  if (!Array.isArray(msg.Activities)) return [];
  return msg.Activities.flatMap((activity, index) => {
    const surfaceId = String(activity?.SurfaceId || '');
    if (!surfaceId) return [];
    const content = activity?.Content;
    const messages = Array.isArray(content?.a2ui_operations)
      ? content.a2ui_operations
      : Array.isArray(content)
        ? content
        : [];
    if (!messages.length) return [];
    const isStudioApprovalSurface = surfaceId.startsWith('approval-')
      && messages.some((operation) => {
        const components = operation?.updateComponents?.components
          || operation?.update_components?.components;
        return Array.isArray(components)
          && components.some((component) => component?.component === 'ApprovalBar');
      });
    // InteractionTray is the canonical approval UI. Replaying the Studio-only
    // compatibility surface would render a second, empty approval rectangle.
    if (isStudioApprovalSurface) return [];
    const sourceMessageId = String(activity.MessageId || '');
    const activityId = sourceMessageId && sourceMessageId !== String(msg.MessageId || '')
      ? sourceMessageId
      : `${sourceMessageId || msg.MessageId || msg.SeqId || 'message'}:a2ui:${surfaceId}:${index}`;
    return [{
      id: activityId,
      role: 'a2ui',
      content: '',
      timestamp: parseTimestamp(msg.Timestamp),
      ...(msg.InvocationId ? { invocationId: String(msg.InvocationId) } : {}),
      ...(Number.isSafeInteger(msg.SeqId) && msg.SeqId > 0 ? { historyOrder: { seq: msg.SeqId, index: index + 1,
        ...(Number.isSafeInteger(msg.StartSeqId) && msg.StartSeqId > 0 ? { group: msg.StartSeqId } : {}),
      } } : {}),
      aguiActivity: { surfaceId, messages: normalizeA2uiOperations(messages),
        ...(typeof content?.interactionId === 'string' ? { interactionId: content.interactionId } : {}),
      },
    }];
  });
}

export function mapBackendMessages(messages) {
  // Messages are cumulative compatibility snapshots: two assistant rows may
  // carry the same call. Keep its first position and its latest recorded facts.
  // A name alone never identifies a call, and calls from different runs/scopes
  // must remain independent.
  const mapped = coalesceHistoryToolCalls(messages.map(mapBackendMessage));
  return coalesceA2uiActivities(mapped.flatMap((message, index) => [message, ...mapBackendActivities(messages[index])]));
}
import { coalesceA2uiActivities } from '../core/a2ui/transcript.js';
import { normalizeA2uiOperations } from '../core/run/a2ui.js';
import { buildBlocksFromHistory } from '../core/run/blocks.js';
import { coalesceHistoryToolCalls } from './history-tool-facts.js';
