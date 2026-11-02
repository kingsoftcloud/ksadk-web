import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import { useSessionLifecycle } from '../../src/hooks/useSessionLifecycle.js';
import { ApiFacadeImpl } from '../../src/core/api/facade.js';
import { ConnectedMessageList } from '../../src/components/chat/ConnectedMessageList.js';
import { useBootstrapStore } from '../../src/stores/bootstrap.js';
import { useSessionStore } from '../../src/stores/session.js';
import { useMessageStore } from '../../src/stores/message.js';
import type { UiCapabilities } from '../../src/types/capabilities.js';

const capabilities = { RunLifecycle: { Enabled: false } } as UiCapabilities;
useBootstrapStore.getState().setAgentId('browser-fixture-agent');
useBootstrapStore.getState().setCapabilities(capabilities);
useSessionStore.getState().setCurrentSessionId('s');
useSessionStore.getState().setLoadingSessions(false);
const api = new ApiFacadeImpl();
let olderAbortController: AbortController | null = null;

function Harness() {
  const actions = useSessionLifecycle({ agentId: 'browser-fixture-agent', currentSessionId: 's',
    isMobile: false, uiCapabilities: capabilities, api, resetCompaction: () => {}, restoreSession: false });
  return <main style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <div style={{ flexShrink: 0, background: 'white', padding: 8 }}>
      <button type="button" onClick={() => void actions.loadSession('s')}>Open S</button>
      <button type="button" onClick={() => void actions.loadSession('t')}>Open T</button>
      <button type="button" onClick={() => void actions.loadOlderSessionMessages('s')}>Older S</button>
      <button type="button" onClick={() => {
        olderAbortController = new AbortController();
        void actions.loadOlderSessionMessages('s', olderAbortController.signal).catch(() => {});
      }}>Older S cancellable</button>
      <button type="button" onClick={() => olderAbortController?.abort()}>Cancel older</button>
      <button type="button" onClick={() => useMessageStore.getState().patchMessages(rows => [
        ...rows,
        { id: 'live-question', role: 'user', content: 'New live question', timestamp: 1, invocationId: 'live-run' },
        { id: 'live-answer', role: 'model', content: 'New live answer', timestamp: 2, invocationId: 'live-run' },
      ])}>Append live turn</button>
    </div>
    <ConnectedMessageList agentName="Fixture" isMobile={false}
      onDeleteFeedback={() => {}} onSubmitFeedback={() => {}}
      onRespondToApproval={() => {}} onLoadOlderSessionMessages={actions.loadOlderSessionMessages} />
  </main>;
}

createRoot(document.getElementById('root')!).render(<Harness />);
