/* eslint-disable react-refresh/only-export-components -- standalone browser fixture */
import { useMemo, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatMessageList } from '../../src/public/chat-timeline.js';
import {
  RuntimeConversationIngress,
  projectConversationItems,
} from '../../src/public/conversation.js';
import { projectConversationStreamForHostedUi } from '../../src/core/conversation/hosted.js';
import fixture from '../../src/__tests__/fixtures/a2a_remote_agent/v1/a2a_stream_tool_terminal.jsonl?raw';
import '../../src/index.css';
import { createScopedAgentBlockActions } from '../../src/core/conversation/scoped-cancel.js';
import { ApiFacadeImpl } from '../../src/core/api/facade.js';
const frames = fixture
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
  .filter((row) => row.kind === 'runtime_event')
  .map((row) => row.payload);
function App() {
  const [seq, setSeq] = useState(11);
  const [cancelState, setCancelState] = useState('none');
  const scrollRef = useRef<HTMLDivElement>(null);
  const contextRef = useRef({ sessionId: 'session', supported: new URLSearchParams(location.search).get('scoped') !== 'false', items: [] as ReturnType<RuntimeConversationIngress['snapshot']>['items'] });
  const actions = useMemo(() => createScopedAgentBlockActions({ api: new ApiFacadeImpl(), agentId: 'remote-fixture-agent', getContext: () => contextRef.current }), []);
  const result = useMemo(() => {
    const ingress = new RuntimeConversationIngress('session');
    frames.slice(0, seq).forEach((frame) => ingress.apply(frame));
    if (cancelState !== 'none') {
      const update = structuredClone(frames[4]);
      update.event_id = `cancel-${cancelState}`;
      update.update.data.cancel.request_state = cancelState;
      ingress.apply(update);
    }
    const state = ingress.snapshot();
    return {
      state,
      presentation: projectConversationItems(state),
      runId: 'root-run-1',
      cursor: seq,
    };
  }, [seq, cancelState]);
  const messages = projectConversationStreamForHostedUi(result).messages;
  contextRef.current.items = result.state.items;
  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex gap-4">
        {[11, 13, 19, 22].map((value) => (
          <button type="button" key={value} onClick={() => setSeq(value)}>
            Sequence {value}
          </button>
        ))}
      </div>
      <button onClick={() => setCancelState('confirmed')}>Confirm child cancellation</button>
      <button onClick={() => setCancelState('unknown')}>Unknown child cancellation</button>
      <div data-testid="root-status">
        {result.presentation.terminalStatus || 'running'}
      </div>
      <ChatMessageList
        agentName="Fixture root" isMobile={false} isStreaming={false} activity={null}
        contextIndicator={null} messages={messages} scrollRef={scrollRef}
        onDeleteFeedback={() => {}} onSubmitFeedback={() => {}}
        onOpenAttachmentPreview={() => {}} onRespondToApproval={() => {}}
        agentBlockActions={contextRef.current.supported ? actions : undefined}
      />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
