import { createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatMessageList } from '../../src/components/chat/ChatMessageList.js';
import { AguiRunClient } from '../../src/core/run/agui.js';
import { dispatchRunEventToStores } from '../../src/core/run/dispatcher.js';
import { useMessageStore } from '../../src/stores/message.js';
import { useSessionStore } from '../../src/stores/session.js';
import '../../src/index.css';

useSessionStore.getState().setCurrentSessionId('session');
useMessageStore.getState().setMessages([{ id: 'history', role: 'model', content: 'History retained', timestamp: 0 }]);
const operations = [
  { version: 'v0.9.1', createSurface: { surfaceId: 'card', catalogId: 'a2ui.org/catalogs/basic/v1.0' } },
  { version: 'v0.9.1', updateComponents: { surfaceId: 'card', components: [{ id: 'card-body', component: 'Card', body: 'Card retained' }] } },
];
const frames = [
  { type: 'RUN_STARTED', threadId: 'session', runId: 'run' },
  { type: 'TEXT_MESSAGE_START', messageId: 'answer', role: 'assistant' },
  { type: 'REASONING_MESSAGE_START', messageId: 'thinking', role: 'reasoning' },
  { type: 'REASONING_MESSAGE_CONTENT', messageId: 'thinking', delta: 'Thinking retained' },
  { type: 'REASONING_MESSAGE_END', messageId: 'thinking' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'answer', delta: 'Initial ' },
  { type: 'TOOL_CALL_START', toolCallId: 'lookup', toolCallName: 'lookup', parentMessageId: 'answer' },
  { type: 'TOOL_CALL_ARGS', toolCallId: 'lookup', delta: '{}' }, { type: 'TOOL_CALL_END', toolCallId: 'lookup' },
  { type: 'TOOL_CALL_RESULT', toolCallId: 'lookup', messageId: 'tool-result', role: 'tool', content: 'Tool retained' },
  { type: 'ACTIVITY_SNAPSHOT', messageId: 'card', activityType: 'a2ui-surface', content: { surfaceId: 'card', content: operations } },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'answer', delta: 'draft' },
  { type: 'CUSTOM', name: 'ksadk.text_message_snapshot', value: { version: 1, threadId: 'session', runId: 'run', messageId: 'answer', content: 'Initial revised answer' } },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'answer', delta: '.' },
  { type: 'TEXT_MESSAGE_END', messageId: 'answer' },
  { type: 'RUN_FINISHED', threadId: 'session', runId: 'run', outcome: { type: 'success' } },
];
const client = new AguiRunClient({ url: '/fixture-stream', agentId: 'agent', threadId: 'session', onEvent: dispatchRunEventToStores,
  // Synthetic HTTP transport; the official HttpAgent and production stores/components run unchanged.
  fetch: async () => new Response(frames.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }),
});
function Fixture() {
  const messages = useMessageStore(state => state.messages);
  return <ChatMessageList agentName="Snapshot review" isMobile={false} isStreaming={false} activity={null} contextIndicator={null}
    messages={messages} scrollRef={createRef()} onOpenAttachmentPreview={() => {}} onRespondToApproval={() => {}}
    onSubmitFeedback={() => {}} onDeleteFeedback={() => {}} />;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
const probe = { run: () => client.run('question', 'run'), messages: () => useMessageStore.getState().messages };
declare global { interface Window { textSnapshotProbe: typeof probe } }
window.textSnapshotProbe = probe;
