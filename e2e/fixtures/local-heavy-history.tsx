import React from 'react';
import { createRoot } from 'react-dom/client';
import { useSessionLifecycle } from '../../src/hooks/useSessionLifecycle.js';
import { ApiFacadeImpl } from '../../src/core/api/facade.js';
import { ConnectedMessageList } from '../../src/components/chat/ConnectedMessageList.js';
import { useBootstrapStore } from '../../src/stores/bootstrap.js';
import { useSessionStore } from '../../src/stores/session.js';
import { useMessageStore } from '../../src/stores/message.js';
import type { UiCapabilities } from '../../src/types/capabilities.js';
import '../../src/index.css';

const capabilities = { RunLifecycle: { Enabled: false } } as UiCapabilities;
const agentId = 'local-heavy-history';
useBootstrapStore.getState().setAgentId(agentId);
useBootstrapStore.getState().setAgentFramework('langgraph');
useBootstrapStore.getState().setCapabilities(capabilities);
useSessionStore.getState().setCurrentSessionId('local-heavy-A');
const api = new ApiFacadeImpl({ agentId });
// Test-only read probe, so assertions can distinguish virtualization from loss.
Object.assign(window, { localHistoryProbe: () => ({
  current: useSessionStore.getState().currentSessionId,
  messages: useMessageStore.getState().messages,
  history: useSessionStore.getState().messageHistory,
}) });

function Harness() {
  const actions = useSessionLifecycle({ agentId, currentSessionId: 'local-heavy-A',
    isMobile: false, uiCapabilities: capabilities, api, resetCompaction: () => {}, restoreSession: false });
  return <main style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <nav style={{ zIndex: 9999, background: 'white', padding: 8 }}>
      {['A', 'B', 'C'].map(slot => <button key={slot} type="button"
        onClick={() => void actions.loadSession('local-heavy-' + slot)}>Open {slot}</button>)}
      <button type="button" onClick={() => void actions.loadOlderSessionMessages('local-heavy-A')}>Older A</button>
    </nav>
    <ConnectedMessageList agentName="Local Docker LangGraph" isMobile={false}
      onDeleteFeedback={() => {}} onSubmitFeedback={() => {}}
      onRespondToApproval={() => {}} onLoadOlderSessionMessages={actions.loadOlderSessionMessages} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
