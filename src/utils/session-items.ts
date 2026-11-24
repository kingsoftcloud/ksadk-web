import type { SessionHistoryItem } from '../api/messages.js';
import type { SessionEventRecord } from '../types/session-events.js';
import type { Message } from '../components/chat/types.js';
import type { ApiFacade } from '../core/api/types.js';
import { mapBackendMessage, mapBackendMessages } from './messages.js';
import { buildMessagesFromSessionEvents } from './session-events.js';
import { persistedRuntimeFrame, rebuildPersistedSessionHistory } from './persisted-session-history.js';
import manifest from '../core/a2ui/assets/manifest.json';
import { orderTranscript } from './transcript-order.js';

type Page = Awaited<ReturnType<ApiFacade['listSessionMessages']>>;
type PageScope = Pick<Page, 'HistoryEpoch' | 'SnapshotSeqId' | 'CursorSource'>;

export function itemPageRecords(page: Page, sessionId: string, previousCursor?: string | null) {
  if (page.HistoryView !== 'items-v1' || !Array.isArray(page.Items)
    || !page.HistoryEpoch || !Number.isSafeInteger(page.SnapshotSeqId)
    || page.HasMore !== Boolean(page.NextItemCursor)
    || (page.HasMore && (!page.Items.length || page.NextItemCursor === previousCursor))) {
    throw new Error('会话条目分页响应无效，请重新打开会话。');
  }
  let last = 0;
  for (const item of page.Items) {
    if (!item.ItemId || !item.Event || item.Event.SessionId !== sessionId
      || !Number.isSafeInteger(item.SeqId) || item.SeqId <= last || item.SeqId > page.SnapshotSeqId!
      || item.SeqId !== item.Event.SeqId || (item.ContentRef && item.ContentRef.SeqId !== item.SeqId)) {
      throw new Error('会话条目与当前历史快照不一致。');
    }
    last = item.SeqId;
  }
  return page.Items;
}

async function readItemJson(api: ApiFacade, sessionId: string, seq: number, scope: PageScope,
  signal: AbortSignal, contentPart?: 'inbox'): Promise<unknown> {
  const chunks: string[] = [];
  let offset = 0;
  while (true) {
    signal.throwIfAborted();
    const page = await api.listSessionMessages(sessionId, { historyView: 'items-v1', contentSeqId: seq,
      contentOffset: offset, contentPart, historyEpoch: scope.HistoryEpoch, snapshotSeqId: scope.SnapshotSeqId, signal });
    if (page.HistoryView !== 'items-v1' || page.HistoryEpoch !== scope.HistoryEpoch
      || page.SnapshotSeqId !== scope.SnapshotSeqId || page.ContentSeqId !== seq || typeof page.ContentChunk !== 'string') {
      throw new Error('历史正文快照已变化，请重新打开会话。');
    }
    chunks.push(page.ContentChunk);
    if (page.NextContentOffset === null) break;
    if (!Number.isSafeInteger(page.NextContentOffset) || page.NextContentOffset! <= offset) {
      throw new Error('历史正文游标无效。');
    }
    offset = page.NextContentOffset!;
  }
  return JSON.parse(chunks.join(''));
}

async function readItemBody(api: ApiFacade, sessionId: string, seq: number, scope: PageScope, signal: AbortSignal) {
  const body = await readItemJson(api, sessionId, seq, scope, signal);
  if (!Array.isArray(body) || body.length !== 2 || !body[0] || typeof body[0] !== 'object') {
    throw new Error('历史正文格式无效。');
  }
  return { Content: body[0], Metadata: body[1] };
}

// Runtime v1 streams have no item reducer. Fold sequence-keyed deltas and
// cumulative snapshots before feeding the existing legacy transcript renderer.
function legacyRows(records: SessionEventRecord[]) {
  const rows: SessionEventRecord[] = [];
  const drafts = new Map<string, { event: SessionEventRecord; parts: string[] }>();
  for (const event of records) {
    if (persistedRuntimeFrame(event)) continue;
    const content = event.Content as (SessionEventRecord['Content'] & { text?: string }) | undefined;
    const text = content?.parts?.map(part => part.text || '').join('') || content?.text || content?.payload?.text || '';
    const key = event.InvocationId || event.EventId;
    const kind = event.EventType;
    if (key && (kind === 'assistant_stream_delta' || kind === 'text.delta' || kind === 'message.delta'
      || kind === 'assistant_stream_snapshot')) {
      const draft = drafts.get(key);
      if (draft && kind !== 'assistant_stream_snapshot') {
        draft.event = event;
        draft.parts.push(text);
      } else drafts.set(key, { event, parts: [text] });
    } else if (kind === 'text.completed' || kind === 'message.completed' || kind === 'assistant_message') {
      if (key) drafts.delete(key);
      rows.push({ ...event, EventType: 'assistant_message',
        Content: content?.parts?.length ? content : { ...content, parts: [{ text }] } });
    } else {
      rows.push(content?.text && !content.parts?.length
        ? { ...event, Content: { ...content, parts: [{ text: content.text }] } } : event);
    }
  }
  for (const { event, parts } of drafts.values()) rows.push({ ...event, EventType: 'assistant_stream_snapshot',
    Metadata: { ...event.Metadata, stream_snapshot: true }, Content: { parts: [{ text: parts.join('') }] } });
  return rows;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function legacyApprovalRows(events: SessionEventRecord[]): Message[] {
  const decisions = new Map<string, string>();
  for (const event of events) {
    if (event.EventType !== 'approval_response') continue;
    const answer = object(event.Metadata?.resume_input);
    const id = answer.approval_request_id || answer.interrupt_id || answer.id;
    if (!id) continue;
    const values = object(answer.value).decisions;
    const action = Array.isArray(values) && object(values[0]).type;
    const status = ['cancelled', 'expired', 'submitted'].includes(String(answer.decision))
      ? String(answer.decision) : answer.approve || answer.approved || action === 'approve' || action === 'edit'
        ? 'approved' : 'denied';
    decisions.set(String(id), status === 'submitted' ? 'completed' : status);
  }
  return events.filter(event => event.EventType === 'approval_request').map(event => {
    const info = object(event.Metadata?.interrupt_info);
    const action = Array.isArray(info.action_requests) ? object(info.action_requests[0]) : {};
    const id = String(info.approval_request_id || info.id || '');
    return mapBackendMessage({ MessageId: event.EventId, Role: 'assistant', SeqId: event.SeqId,
      InvocationId: event.InvocationId, Timestamp: event.Timestamp, ToolEvents: [{
        Type: 'approval', Name: info.tool_name || action.name || 'approval', ApprovalRequestId: id,
        Protocol: event.Metadata?.protocol, Status: decisions.get(id) || 'paused',
        Args: info.arguments ?? info.tool_args ?? info.args ?? action.args ?? action.arguments,
        ApprovalMessage: info.approval_message || info.message || action.description,
      }] }) as Message;
  });
}

function componentList(raw: unknown): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  function append(rawComponent: unknown): string {
    const node = object(rawComponent);
    const id = String(node.id || node.component_id || '');
    const component = String(node.component || node.type || '');
    if (!id || !component) return '';
    const props = object(node.props);
    const children = Array.isArray(node.children) ? node.children.map(append).filter(Boolean) : [];
    entries.push({ id, component, ...props, ...(children.length && !props.children && !props.child ? { children } : {}) });
    return id;
  }
  if (Array.isArray(raw)) raw.forEach(append);
  return entries;
}

function legacyActivityRows(events: SessionEventRecord[]): Message[] {
  const messages = events.flatMap(event => {
    if (!event.EventType?.startsWith('a2ui.surface.')) return [];
    const content = object(event.Content);
    const payload = Object.keys(object(content.payload)).length ? object(content.payload) : content;
    const surfaceId = String(payload.surfaceId || payload.surface_id || '');
    if (!surfaceId) return [];
    const explicit = payload.operations || payload.a2ui_operations;
    const surface = payload.surface ? object(payload.surface) : payload;
    const components = componentList(surface.components);
    const data = surface.data_model ?? surface.dataModel;
    const ops = Array.isArray(explicit) ? explicit : event.EventType === 'a2ui.surface.end'
      ? [{ version: 'v0.9', deleteSurface: { surfaceId } }]
      : [
          ...(event.EventType === 'a2ui.surface.begin' ? [{ version: 'v0.9', createSurface: { surfaceId,
            catalogId: surface.catalog_id || surface.catalogId || manifest.catalog_id } }] : []),
          ...(components.length ? [{ version: 'v0.9', updateComponents: { surfaceId, components } }] : []),
          ...(data === undefined ? [] : [{ version: 'v0.9', updateDataModel: { surfaceId, path: '/', value: data } }]),
        ];
    if (!ops.length) return [];
    return [{ MessageId: event.EventId, Role: 'assistant', SeqId: event.SeqId, Timestamp: event.Timestamp,
      InvocationId: event.InvocationId, Activities: [{ SurfaceId: surfaceId,
        Content: { a2ui_operations: ops, interactionId: payload.interactionId } }] }];
  });
  return (mapBackendMessages(messages) as Message[]).filter(row => row.role === 'a2ui');
}

function inputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(inputText).join('');
  const data = object(value);
  const nested = data.text ?? data.content ?? data.parts;
  return nested === undefined ? '' : inputText(nested);
}

const CHAT_EVENT_TYPES = new Set([
  'user_message', 'assistant_message', 'assistant_stream_snapshot', 'reasoning',
  'tool_call', 'tool_result', 'stage_tool_call', 'stage_tool_result', 'tool.call.begin', 'tool.call.end',
  'approval_request', 'approval_response', 'reasoning.delta', 'reasoning.completed', 'context_checkpoint',
  'a2ui.surface.begin', 'a2ui.surface.update', 'a2ui.surface.end',
  'run_status', 'run.started', 'run.progress', 'run.completed', 'run.interrupted', 'run.failed', 'run.canceled',
]);

export function projectItemHistory(
  items: SessionHistoryItem[], api: ApiFacade, sessionId: string, scope: PageScope,
  profile: 'flat-v1' | 'agent-block-v1',
) {
  const records = items.filter(item => !item.ContentRef).map(item => item.Event);
  // Accepted inbox text can precede (or replace) a native user item. A verified
  // command id is stable across pages, even for two prompts with identical text.
  const nativeInputs = new Set(items.filter(item => {
    if (!item.InputCommandId || item.InboxInput) return false;
    const frame = persistedRuntimeFrame(item.Event);
    const source = object(object(frame?.source).metadata);
    const parts = object(frame?.snapshot).parts;
    return item.EventType === 'user_message' || (frame?.event_type === 'item.completed'
      && (source.native_item_kind === 'userMessage'
        || Array.isArray(parts) && parts.some(part => object(object(part).data).type === 'userMessage')));
  }).map(item => item.InputCommandId).filter(Boolean));
  const missingInputs = items.filter(item => item.InboxInput && !nativeInputs.has(item.InboxInput.CommandId));
  const inputs = missingInputs.flatMap(item => item.InboxInput?.Text !== undefined
    ? [{ ...item.Event, EventId: 'inbox:' + item.InboxInput.CommandId, EventType: 'user_message',
      Content: { parts: [{ text: item.InboxInput.Text }] } }] : []);
  const legacy = legacyRows([...records, ...inputs].sort((a, b) => Number(a.SeqId) - Number(b.SeqId)));
  const fallback = [...buildMessagesFromSessionEvents(legacy, { preserveDistinctEvents: true }), ...legacyApprovalRows(legacy), ...legacyActivityRows(legacy)] as Message[];
  const result = rebuildPersistedSessionHistory(fallback, records, sessionId, profile);
  const deferred: Message[] = items.filter(item => item.ContentRef).map(item => ({
    id: 'history-body:' + item.ItemId, role: 'system', content: item.EventType,
    timestamp: Number(item.Event.Timestamp) || 0, historyOrder: { seq: item.SeqId },
    invocationId: item.InvocationId,
    readHistoryContent: async signal => {
      const body = await readItemBody(api, sessionId, item.SeqId, scope, signal);
      const envelope = object(body.Content?.session_event);
      const imported = envelope.family === 'workflow' && object(object(envelope.payload).legacy_history_event);
      const event = imported && imported.EventType
        ? { ...imported, SessionId: sessionId, SeqId: item.SeqId } as SessionEventRecord
        : { ...item.Event, ...body };
      const projected = rebuildPersistedSessionHistory(
        buildMessagesFromSessionEvents(legacyRows([event])) as Message[], [event], sessionId, profile);
      return projected.messages.flatMap(row => [
        row.content, row.reasoning, ...Object.values(row.tools || {}).map(tool => JSON.stringify(tool, null, 2)),
      ]).filter(Boolean).join('\n') || '此事件没有可展示的正文。';
    },
  }));
  for (const item of missingInputs) {
    const input = item.InboxInput!;
    if (!input.ContentRef) continue;
    deferred.push({ id: 'inbox:' + input.CommandId, role: 'user', content: '用户输入',
      timestamp: Number(item.Event.Timestamp) || 0, historyOrder: { seq: item.SeqId },
      invocationId: item.InvocationId, readHistoryContent: async signal =>
        inputText(await readItemJson(api, sessionId, item.SeqId, scope, signal, 'inbox')) });
  }
  // Historical adapters can carry extension event types. Keep their positions
  // inspectable while keeping internal provider and state payloads out of the UI.
  const extensions = new Map<string, SessionEventRecord[]>();
  for (const event of legacy) {
    if (!event.EventType || CHAT_EVENT_TYPES.has(event.EventType) || event.Content?.session_event) continue;
    const run = event.InvocationId || '';
    const group = extensions.get(run);
    if (group) group.push(event);
    else extensions.set(run, [event]);
  }
  for (const [run, events] of extensions) {
    deferred.push({ id: 'history-details:' + run, role: 'system', content: `历史事件（${events.length}）`,
      timestamp: Number(events[0].Timestamp) || 0, historyOrder: { seq: events[0].SeqId! }, invocationId: run,
      readHistoryContent: async () => events.map(event => {
        const detail = event.EventType === 'progress' ? inputText(event.Content?.parts) : '';
        return [event.SeqId, event.EventType, detail].filter(Boolean).join('  ');
      }).join('\n') });
  }
  return { ...result, messages: deferred.length ? orderTranscript([...result.messages, ...deferred]) : result.messages };
}

/** A disconnect may span several pages or an entire run. Pin the catch-up snapshot
 * on its first response; live subscription resumes after the last applied row. */
export async function catchUpSessionItems(
  api: ApiFacade, sessionId: string, afterSeqId: number, historyEpoch: string,
  signal: AbortSignal, apply: (event: SessionHistoryItem['Event']) => void,
) {
  let cursor: string | undefined;
  let latest = afterSeqId;
  let snapshot: number | undefined;
  do {
    signal.throwIfAborted();
    const page = await api.listSessionMessages(sessionId, {
      historyView: 'items-v1', ...(cursor ? { itemCursor: cursor } : { afterSeqId }),
      historyEpoch, snapshotSeqId: snapshot, signal, limit: 100,
    });
    if (page.HistoryEpoch !== historyEpoch || (snapshot !== undefined && page.SnapshotSeqId !== snapshot)) {
      throw new Error('接续历史来源已变化。');
    }
    snapshot = page.SnapshotSeqId;
    for (const item of itemPageRecords(page, sessionId, cursor)) {
      if (item.SeqId <= latest) throw new Error('接续历史条目未前进。');
      const event = item.ContentRef
        ? { ...item.Event, ...await readItemBody(api, sessionId, item.SeqId, page, signal) } : item.Event;
      signal.throwIfAborted();
      apply(event);
      latest = item.SeqId;
    }
    cursor = page.NextItemCursor || undefined;
  } while (cursor);
  return latest;
}
