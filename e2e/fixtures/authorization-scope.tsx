import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentAuthorizationBoundary } from '../../src/components/AgentAuthorizationBoundary';
import { usePermissionStore } from '../../src/stores/permission';
import { useSessionStore } from '../../src/stores/session';
import { readPersistedSessionId, writePersistedSessionId } from '../../src/utils/session';
import '../../src/embed.css';

// Browser-only fixture, no real credentials or production API requests.
const principalKey = 'ksadk.authorization-fixture.principal';
export function Probe({ principal }: { principal: string }) {
  const [draft, setDraft] = useState('');
  const [selected, setSelected] = useState(() => readPersistedSessionId('fixture-agent'));
  const permission = usePermissionStore(s => s.permissionMode);
  const pins = useSessionStore(s => s.pinnedSessionIds);
  return <div className="ksadk-web"><section>
    <h1>当前身份 {principal}</h1>
    <p>已选会话：{selected || '无'}</p><p>置顶：{pins.join(',') || '无'}</p>
    <p>审批：{permission}</p>
    <input aria-label="身份草稿" value={draft} onChange={e => setDraft(e.target.value)} />
    <button onClick={() => {
      const id = `${principal}-session`;
      writePersistedSessionId('fixture-agent', id);
      setSelected(id);
      useSessionStore.getState().togglePinnedSession(id);
      usePermissionStore.getState().setPermissionMode('full');
      // Deliberately not cleaned up on component unmount: a document boundary
      // must also stop callbacks outside React's cleanup discipline.
      setTimeout(() => localStorage.setItem('ksadk.authorization-fixture.late', principal), 15000);
    }}>保存身份缓存并安排旧回调</button>
  </section></div>;
}
export function Fixture() {
  const [principal, setPrincipal] = useState(() => localStorage.getItem(principalKey) || 'A');
  const [late, setLate] = useState('未检查');
  return <>
    <p>迟到回调：{late}</p>
    <button onClick={() => setLate(localStorage.getItem('ksadk.authorization-fixture.late') || '无')}>检查迟到回调</button>
    <button onClick={() => {
      const next = principal === 'A' ? 'B' : 'A';
      localStorage.setItem(principalKey, next);
      setPrincipal(next);
    }}>切换身份</button>
    <AgentAuthorizationBoundary authorizationScopeKey={`fixture:${principal}`}>
      <Probe principal={principal} />
    </AgentAuthorizationBoundary>
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
