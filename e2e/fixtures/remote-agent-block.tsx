/* eslint-disable react-refresh/only-export-components -- standalone browser fixture */
import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentBlockView } from '../../src/public/chat-timeline.js';
import {
  RuntimeConversationIngress,
  projectConversationItems,
} from '../../src/public/conversation.js';
import { projectConversationStreamForHostedUi } from '../../src/core/conversation/hosted.js';
import fixture from '../../src/__tests__/fixtures/a2a_remote_agent/v1/a2a_stream_tool_terminal.jsonl?raw';
import '../../src/index.css';
const frames = fixture
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
  .filter((row) => row.kind === 'runtime_event')
  .map((row) => row.payload);
function App() {
  const [seq, setSeq] = useState(11);
  const result = useMemo(() => {
    const ingress = new RuntimeConversationIngress('session');
    frames.slice(0, seq).forEach((frame) => ingress.apply(frame));
    const state = ingress.snapshot();
    return {
      state,
      presentation: projectConversationItems(state),
      runId: 'root-run-1',
      cursor: seq,
    };
  }, [seq]);
  const messages = projectConversationStreamForHostedUi(result).messages;
  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex gap-4">
        {[11, 13, 19, 22].map((value) => (
          <button type="button" key={value} onClick={() => setSeq(value)}>
            Sequence {value}
          </button>
        ))}
      </div>
      <div data-testid="root-status">
        {result.presentation.terminalStatus || 'running'}
      </div>
      {messages.map((message) =>
        message.agentBlock ? (
          <AgentBlockView key={message.id} block={message.agentBlock} />
        ) : (
          <p key={message.id}>{message.content}</p>
        ),
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
