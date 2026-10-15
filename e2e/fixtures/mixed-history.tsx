import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useSessionLifecycle } from '../../src/hooks/useSessionLifecycle.js';
import { ApiFacadeImpl } from '../../src/core/api/facade.js';
import { ConnectedMessageList } from '../../src/components/chat/ConnectedMessageList.js';
import { useBootstrapStore } from '../../src/stores/bootstrap.js';
import { useSessionStore } from '../../src/stores/session.js';
import { useMessageStore } from '../../src/stores/message.js';
import type { UiCapabilities } from '../../src/types/capabilities.js';
import '../../src/index.css';

const kind = new URLSearchParams(location.search).get('version') === 'old' ? 'old' : 'new';
const agentId = 'ar-acceptance-history' + (kind === 'old' ? '-old' : '');
const capabilities = { RunLifecycle: { Enabled: false } } as UiCapabilities;
useBootstrapStore.getState().setAgentId(agentId);
useBootstrapStore.getState().setAgentFramework('langgraph');
useBootstrapStore.getState().setCapabilities(capabilities);
const api = new ApiFacadeImpl({ agentId });
Object.assign(window, { mixedHistoryProbe: () => ({
  current: useSessionStore.getState().currentSessionId,
  messages: useMessageStore.getState().messages,
  history: useSessionStore.getState().messageHistory,
}) });

function Harness() {
  const [revealMessage, setRevealMessage] = useState<{ id: string; request: number } | null>(null);
  const currentSessionId = useSessionStore(state => state.currentSessionId);
  const actions = useSessionLifecycle({ agentId, currentSessionId,
    isMobile: false, uiCapabilities: capabilities, api, resetCompaction: () => {}, restoreSession: false });
  return <main style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <nav style={{ zIndex: 9999, background: 'white', padding: 8 }}>
      {[100, 10000, 100000].map(size => <button key={size} type="button"
        onClick={() => {
          setRevealMessage(null);
          void actions.loadSession(`mixed-${kind}-${size}`);
        }}>Open {size}</button>)}
      <button type="button" onClick={() => void actions.loadOlderSessionMessages(`mixed-${kind}-100000`)}>Older</button>
      <button type="button" onClick={() => {
        const target = useMessageStore.getState().messages.find(row => row.content === 'append-50');
        if (target) setRevealMessage({ id: target.id, request: Date.now() });
      }}>Reveal append-50</button>
    </nav>
    <ConnectedMessageList agentName={`Real ${kind} Runtime`} isMobile={false}
      onDeleteFeedback={() => {}} onSubmitFeedback={() => {}}
      onRespondToApproval={() => {}} onLoadOlderSessionMessages={actions.loadOlderSessionMessages}
      revealMessage={revealMessage} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
