import { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { useAgentChat } from '../src/hooks/useAgentChat.js';
import { ConnectedMessageList } from '../src/components/chat/ConnectedMessageList.js';
import { ConnectedComposer } from '../src/components/chat/ConnectedComposer.js';
import { ConversationController } from '../src/core/conversation/studio-controller.js';
import type { ApiFacade } from '../src/core/api/types.js';
import '../src/index.css';

// Only this backend is synthetic. Its durable records survive page.reload();
// session selection, recovery, engine, stores and transcript use production code.
type Frame = Record<string, any>;
type Run = { runId: string; status: string; text: string; frames: Frame[] };
type Backend = { runs: Record<string, Run>; submissions: number; cancellations: number };
const key = 'fixture:running-feedback:backend';
const backend: Backend = JSON.parse(localStorage.getItem(key) || 'null') || { runs: {}, submissions: 0, cancellations: 0 };
let revision = 0;
const listeners = new Set<() => void>();
const changed = () => { localStorage.setItem(key, JSON.stringify(backend)); revision++; listeners.forEach(fn => fn()); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const controller = new ConversationController('fixture:running-feedback');
const sessions = ['a', 'b'].map(id => ({ SessionId: id, AgentId: 'agent', Title: `Session ${id.toUpperCase()}` }));
const open = new Set<{ sessionId: string; wrapped: boolean; sink: ReadableStreamDefaultController<Uint8Array> }>();
const encode = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
const record = (sessionId: string, frame: Frame) => ({ SessionId: sessionId, InvocationId: frame.run_id,
  EventId: frame.event_id, SeqId: frame.seq, EventType: frame.event_type.startsWith('run.') ? 'run_status' : frame.event_type,
  Content: { runtime_event: frame, ...(frame.event_type === 'run.completed' ? { status: 'completed' } : {}) } });
function emit(sessionId: string, data: Frame) {
  const run = backend.runs[sessionId];
  const seq = run.frames.length + 1;
  const frame = { schema_version: 2, family: 'runtime', seq, event_id: `${run.runId}:${seq}`,
    run_id: run.runId, scope_id: 'root', timestamp: Date.now() / 1000,
    source: { framework: 'langgraph', metadata: {} }, ...data };
  run.frames.push(frame);
  for (const entry of open) if (entry.sessionId === sessionId) entry.sink.enqueue(encode(entry.wrapped ? record(sessionId, frame) : frame));
  changed();
}
function stream(sessionId: string, afterSeqId: number, wrapped: boolean, signal?: AbortSignal) {
  let entry: { sessionId: string; wrapped: boolean; sink: ReadableStreamDefaultController<Uint8Array> };
  return new ReadableStream<Uint8Array>({
    start(sink) {
      entry = { sessionId, wrapped, sink }; open.add(entry);
      for (const frame of backend.runs[sessionId]?.frames || []) {
        if (frame.seq > afterSeqId) sink.enqueue(encode(wrapped ? record(sessionId, frame) : frame));
      }
      sink.enqueue(new TextEncoder().encode(': ping\n\n'));
      signal?.addEventListener('abort', () => {
        if (open.delete(entry)) sink.error(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    },
    cancel() { open.delete(entry); },
  });
}
function finish(sessionId: string) {
  const run = backend.runs[sessionId];
  if (!run || run.status !== 'running') return;
  emit(sessionId, { event_type: 'item.completed', item_id: 'result', item_kind: 'tool_result',
    snapshot: { parts: [{ content_type: 'tool_result', part_id: 'result', call_id: 'lookup', result: '查询完成' }] } });
  emit(sessionId, { event_type: 'item.completed', item_id: 'answer', item_kind: 'message', phase: 'final_answer',
    snapshot: { parts: [{ content_type: 'text', part_id: 'answer', text: '任务已完成，查询结果已整理。' }] } });
  run.status = 'completed';
  emit(sessionId, { event_type: 'run.completed', status: 'completed' });
}
const api = {
  async getAgentUiBootstrap() {
    return { Agent: { AgentId: 'agent', Name: '运行反馈验证', Framework: 'langgraph' },
      Capabilities: { HostedChat: { Enabled: true, ApiFormats: ['responses'] }, StopRun: true,
        KernelSessionEvents: true, KernelSessionEventsByCommand: true,
        RunLifecycle: { Enabled: true, Resume: true, Checkpoints: false } },
      Model: { id: 'fixture', display_name: 'Fixture' } };
  },
  async listAgentModels() { return { Models: [{ id: 'fixture' }], Current: 'fixture' }; },
  async listSessions() { return { Sessions: sessions, Total: sessions.length }; },
  async listSessionMessages(sessionId: string) {
    const run = backend.runs[sessionId];
    return { Messages: run ? [{ MessageId: `${run.runId}:user`, Role: 'user', Content: { text: run.text }, InvocationId: run.runId }] : [],
      LatestSeqId: run?.frames.length || 0, HasMore: false };
  },
  async listSessionEvents(sessionId: string) {
    const events = (backend.runs[sessionId]?.frames || []).map(frame => record(sessionId, frame));
    return { Events: events, Total: events.length };
  },
  async getSession(sessionId: string) {
    const run = backend.runs[sessionId];
    return { SessionId: sessionId, ActiveInvocationId: run?.runId, ActiveRunStatus: run?.status };
  },
  async runAgent(body: Record<string, any>) {
    backend.submissions++;
    const sessionId = body.SessionId;
    const runId = `run-${backend.submissions}`;
    backend.runs[sessionId] = { runId, status: 'running', text: body.Messages[0].content.map((part: { text?: string }) => part.text || '').join(''), frames: [] };
    emit(sessionId, { event_type: 'run.started', status: 'running' });
    emit(sessionId, { event_type: 'item.started', item_kind: 'reasoning', item_id: 'thinking' });
    emit(sessionId, { event_type: 'item.completed', item_kind: 'reasoning', item_id: 'thinking',
      snapshot: { parts: [{ content_type: 'text', part_id: 'reasoning', text: '先核对查询范围，再调用工具。' }] } });
    const call = { parts: [{ content_type: 'tool_call', part_id: 'call', call_id: 'lookup', name: 'lookup', arguments: { range: 'week' } }] };
    emit(sessionId, { event_type: 'item.started', item_kind: 'tool_call', item_id: 'lookup', initial: call });
    emit(sessionId, { event_type: 'item.completed', item_kind: 'tool_call', item_id: 'lookup', snapshot: call });
    return new ReadableStream<Uint8Array>({ start(sink) { sink.enqueue(new TextEncoder().encode(JSON.stringify({ Data: {
      ReceiptStatus: 'accepted', RunId: runId, CommandId: `command-${backend.submissions}`,
    } }))); sink.close(); } });
  },
  async subscribeSessionEvents(sessionId: string, after: number, options?: { signal?: AbortSignal }) { return stream(sessionId, after, false, options?.signal); },
  async subscribeRunEvents(params: { sessionId: string; afterSeqId: number }, options?: { signal?: AbortSignal }) { return stream(params.sessionId, params.afterSeqId, true, options?.signal); },
  async cancelRun() { backend.cancellations++; changed(); return {}; },
  async getResponseFeedback() { return null; },
} as unknown as ApiFacade;

function App() {
  useSyncExternalStore(subscribe, () => revision);
  const chat = useAgentChat({ api, agentId: 'agent', conversationController: controller, conversationClient: null });
  return <main style={{ padding: 16, maxWidth: 900, margin: 'auto' }}>
    <h1>极简运行提示 · 真实组件验证</h1>
    <nav style={{ display: 'flex', gap: 16 }}>
      {sessions.map(session => <button key={session.SessionId} onClick={() => chat.selectSession(session.SessionId)}>{session.Title}</button>)}
    </nav>
    <output data-testid="selection">{JSON.stringify({ sessionId: chat.currentSessionId, status: chat.bootstrapStatus })}</output>
    <section data-testid="timeline" style={{ height: 400, display: 'flex' }}>
      <ConnectedMessageList agentName={chat.agentName} isMobile={chat.isMobile} onDeleteFeedback={() => {}}
        onSubmitFeedback={() => {}} onRespondToApproval={() => {}} />
    </section>
    <ConnectedComposer draftKey={chat.conversationId} draftStore={chat.conversationDrafts} composerMaxHeight={180}
      isMobile={chat.isMobile} attachmentsEnabled={false} stopGeneration={chat.stop}
      submitDraft={async (text, attachments) => chat.send(text, { attachments })} />
    <aside aria-label="Synthetic backend controls">
      <button onClick={() => finish('a')}>Finish A in backend</button>{' / '}
      <button onClick={() => {
        for (const entry of open) entry.sink.error(new TypeError('Network disconnected'));
        open.clear();
      }}>Disconnect subscriptions</button>
    </aside>
    <pre data-testid="audit">{JSON.stringify({ submissions: backend.submissions, cancellations: backend.cancellations })}</pre>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
