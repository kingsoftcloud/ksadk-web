import { useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { useAgentChat } from '../src/hooks/useAgentChat.js';
import { ConnectedComposer } from '../src/components/chat/ConnectedComposer.js';
import { ConnectedMessageList } from '../src/components/chat/ConnectedMessageList.js';
import { ConversationController } from '../src/core/conversation/studio-controller.js';
import type { ApiFacade } from '../src/core/api/types.js';
import { useStreamingStore } from '../src/stores/streaming.js';
import '../src/index.css';

// Only the transport is synthetic. React effects, stores, run engine, composer
// and transcript renderer are the same modules shipped in the public library.
let revision = 0;
const listeners = new Set<() => void>();
const changed = () => { revision++; listeners.forEach(fn => fn()); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const creations: Array<{ id: number; agentId: string; done: boolean; resolve: () => void; reject: () => void }> = [];
const runs: Array<{ id: number; agentId: string; sessionId: string; invocationId: string; text: string; body: unknown; closed: boolean; emit: () => void; finish: () => void }> = [];
const cancellations: Array<{ agentId: string; sessionId: string; invocationId: string }> = [];
const sessions: Array<{ SessionId: string; AgentId: string; Title: string }> = [];
const controller = new ConversationController('fixture:run-ownership');

const api = {
  async getAgentUiBootstrap(agentId: string) {
    return { Agent: { AgentId: agentId, Name: agentId, Framework: 'hermes' },
      Capabilities: { HostedChat: { Enabled: true, ApiFormats: ['responses'] }, StopRun: true },
      Model: { id: `model-${agentId}`, display_name: `Model ${agentId}` } };
  },
  async listAgentModels(agentId: string) { return { Models: [{ id: `model-${agentId}` }], Current: `model-${agentId}` }; },
  async listSessions(agentId: string) { const items = sessions.filter(item => item.AgentId === agentId); return { Sessions: items, Total: items.length }; },
  async listSessionMessages() { return { Messages: [], LatestSeqId: 0, HasMore: false }; },
  async listSessionEvents() { return { Events: [], LatestSeqId: 0, HasMore: false }; },
  async getSession(sessionId: string) { return { SessionId: sessionId }; },
  createSession(agentId: string) {
    return new Promise((resolve, reject) => {
      const id = creations.length + 1;
      creations.push({ id, agentId, done: false,
        resolve: () => {
          creations[id - 1].done = true;
          sessions.push({ SessionId: `native-${id}`, AgentId: agentId, Title: `Conversation ${id}` });
          resolve({ SessionId: `native-${id}` }); changed();
        },
        reject: () => { creations[id - 1].done = true; reject(new Error('CreateSession unavailable')); changed(); },
      });
      changed();
    });
  },
  async runAgent(body: Record<string, unknown>, options?: { signal?: AbortSignal }) {
    const id = runs.length + 1;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { streamController = value; } });
    const event = (data: unknown) => streamController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
    const content = (body.Messages as Array<{ content: Array<{ text?: string }> }>)[0].content;
    const run = { id, agentId: String(body.AgentId), sessionId: String(body.SessionId),
      invocationId: String(body.InvocationId), text: content.map(part => part.text || '').join(''), body, closed: false,
      emit: () => { if (!run.closed) event({ type: 'response.output_text.delta', delta: `output ${id} ` }); },
      finish: () => {
        if (run.closed) return;
        event({ type: 'response.completed', response: { status: 'completed' } });
        streamController.close(); run.closed = true; changed();
      },
    };
    runs.push(run);
    event({ type: 'response.in_progress' });
    options?.signal?.addEventListener('abort', () => {
      if (run.closed) return;
      run.closed = true; streamController.error(new DOMException('Aborted', 'AbortError')); changed();
    }, { once: true });
    changed(); return stream;
  },
  async cancelRun(agentId: string, sessionId: string, invocationId: string) {
    cancellations.push({ agentId, sessionId, invocationId }); changed(); return {};
  },
} as unknown as ApiFacade;

function App() {
  useSyncExternalStore(subscribe, () => revision);
  const [agentId, setAgentId] = useState('agent-a');
  const chat = useAgentChat({ api, agentId, conversationController: controller, restoreSession: false, conversationClient: null });
  const streaming = useStreamingStore(s => s.sessionStreaming);
  return <main style={{ padding: 20, maxWidth: 1000, margin: 'auto' }}>
    <h1>Production renderer · synthetic transport</h1>
    <nav style={{ display: 'flex', gap: 20 }}>
      <button onClick={chat.startNewConversation}>New conversation</button>
      <button onClick={() => setAgentId(agentId === 'agent-a' ? 'agent-b' : 'agent-a')}>Switch Agent</button>
    </nav>
    <output data-testid="selection">{JSON.stringify({ agentId: chat.agentId, conversationId: chat.conversationId, sessionId: chat.currentSessionId, status: chat.bootstrapStatus, isStreaming: chat.isStreaming })}</output>
    <section data-testid="timeline" style={{ height: 280, overflow: 'auto', display: 'flex' }}>
      <ConnectedMessageList agentName={chat.agentName} isMobile={false} onDeleteFeedback={() => {}}
        onSubmitFeedback={() => {}} onRespondToApproval={() => {}} />
    </section>
    <ConnectedComposer draftKey={chat.conversationId} draftStore={chat.conversationDrafts} composerMaxHeight={180}
      isMobile={false} attachmentsEnabled={false} stopGeneration={chat.stop}
      submitDraft={async (text, attachments) => chat.send(text, { attachments })} />
    <aside aria-label="Synthetic transport controls" style={{ paddingTop: 20 }}>
      {creations.filter(item => !item.done).map(item => <div key={item.id}>
        <button onClick={item.resolve}>Resolve creation {item.id}</button>{' / '}
        <button onClick={item.reject}>Fail creation {item.id}</button>
      </div>)}
      {runs.filter(item => !item.closed).map(item => <div key={item.id}>
        <button onClick={item.emit}>Emit run {item.id}</button>{' / '}
        <button onClick={item.finish}>Finish run {item.id}</button>
      </div>)}
    </aside>
    <pre data-testid="audit">{JSON.stringify({ creations: creations.map(({ id, agentId, done }) => ({ id, agentId, done })),
      runs: runs.map(({ id, agentId, sessionId, invocationId, text, body, closed }) => ({ id, agentId, sessionId, invocationId, text, body, closed })),
      cancellations, streaming: Object.keys(streaming) })}</pre>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
