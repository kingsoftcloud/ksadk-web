import { createRef, useRef, useState } from 'react';
import '../../src/index.css';
import { ChatMessageList } from '../../src/components/chat/ChatMessageList.js';
import { createRoot } from 'react-dom/client';
import { LegacyA2UISurface } from '../../src/components/chat/LegacyA2UISurface.js';
import { A2UIActivityMessage } from '../../src/components/chat/A2UIActivityMessage.js';
import { InteractionA2uiSurface } from '../../src/components/chat/InteractionA2uiSurface.js';
import { InteractionTray } from '../../src/components/chat/InteractionTray.js';
import { a2uiCatalog, a2uiManifest } from '../../src/core/a2ui/catalog.js';
import type { Interaction } from '../../src/core/interaction/types.js';
import type { Message } from '../../src/components/chat/types.js';
import { A2uiCatalogProvider } from '../../src/core/a2ui/provider.js';
import { customCatalogRegistry } from '../../examples/custom-catalog/registry.js';

type Messages = Record<string, unknown>[];
const root = createRoot(document.getElementById('root')!);
const presentation = (messages: Messages) => ({ wireVersion: '0.9.1', catalogDigest: a2uiManifest.catalog_digest, messages });
const record = (messages: Messages, interactionId: string, kind: Interaction['kind']): Interaction => ({
  interactionId, sessionId: 'session', runId: 'run', kind, title: 'Review', message: 'Check the operation',
  requestSchema: {}, presentation: { a2ui: presentation(messages) }, status: 'pending', revision: 1,
  createdAt: '', expiresAt: null, resolvedAt: null, actor: null, outcome: null,
  responseSummary: null, source: 'interaction_v1', extensions: {},
});

function LayoutHistory({ long }: { long: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showResult, setShowResult] = useState(false);
  const [reveal, setReveal] = useState(0);
  const inputMessages: Messages = [
    { version: 'v0.9', createSurface: { surfaceId: 'input', catalogId: 'a2ui.org/catalogs/basic/v1.0' } },
    { version: 'v0.9', updateComponents: { surfaceId: 'input', components: [
      { id: 'form', component: 'Form', title: '历史输入', fields: Array.from({ length: 6 }, (_, i) => ({
        name: `field${i}`, label: `参数 ${i}`, type: 'string',
      })) },
    ] } },
  ];
  const input: Interaction = { ...record(inputMessages, 'input-wait', 'structured_input'), status: 'resolved', outcome: 'submitted',
    requestSchema: { type: 'object', properties: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`field${i}`, { type: 'string' }])) },
    response: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`field${i}`, `已提交 ${i}`])),
  };
  const hidden: Interaction[] = [0, 1].map(i => {
    const surfaceId = `hidden-${i}`;
    return { ...record([
      { version: 'v0.9', createSurface: { surfaceId, catalogId: 'a2ui.org/catalogs/basic/v1.0' } },
      { version: 'v0.9', updateComponents: { surfaceId, components: [
        { id: 'plan', component: 'Card', body: '已保存的审批详情' }, { id: 'bar', component: 'ApprovalBar' },
      ] } },
    ], `approval-${i}`, 'approval'), status: 'resolved', outcome: 'approved' };
  });
  const messages: Message[] = [
    ...Array.from({ length: long ? 70 : 0 }, (_, i): Message => ({
      id: `earlier-${i}`, role: 'model', content: `早期历史消息 ${i}`, timestamp: i,
    })),
    { id: 'input-row', runId: 'run', role: 'a2ui', content: '', timestamp: 100,
      aguiActivity: { surfaceId: 'input', messages: inputMessages, interactionId: input.interactionId } },
    ...hidden.map((interaction, i): Message => ({
      id: `hidden-${i}`, runId: 'run', role: 'a2ui', content: '', timestamp: 101 + i,
      aguiActivity: { surfaceId: `hidden-${i}`, interactionId: interaction.interactionId,
        messages: [...interaction.presentation!.a2ui!.messages, ...(showResult && i === 0 ? [
          { version: 'v0.9', updateComponents: { surfaceId: 'hidden-0', components: [
            { id: 'plan', component: 'Card', body: '后续结果卡' },
          ] } },
        ] : [])] },
    })),
    { id: 'layout-result', runId: 'run', role: 'model', content: '最终回答仍然可见', timestamp: 104 },
    ...Array.from({ length: long ? 30 : 0 }, (_, i): Message => ({
      id: `later-${i}`, role: 'model', content: `后续历史消息 ${i}`, timestamp: 105 + i,
    })),
  ];
  return <main style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <nav><button onClick={() => setShowResult(value => !value)}>{showResult ? '隐藏结果卡' : '显示结果卡'}</button>
      <button onClick={() => setReveal(value => value + 1)}>定位最终回答</button></nav>
    <ChatMessageList agentName="Layout" isMobile={false} isStreaming={false} activity={null} contextIndicator={null}
      messages={messages} interactionRecords={[input, ...hidden]} scrollRef={scrollRef}
      revealMessage={reveal ? { id: 'layout-result', request: reveal } : null}
      onOpenAttachmentPreview={() => {}} onRespondToApproval={() => {}}
      onSubmitFeedback={() => {}} onDeleteFeedback={() => {}} />
  </main>;
}

const probe = {
  actions: [] as unknown[],
  layout(long = false) {
    root.render(<LayoutHistory long={long} />);
  },
  legacy(messages: Messages, surfaceId = 's') {
    root.render(<LegacyA2UISurface surfaceId={surfaceId} messages={messages} disabled={false}
      onAction={action => { probe.actions.push(action); }} />);
  },
  mixedCatalogs(messages: Messages, disabled = false) {
    root.render(<A2uiCatalogProvider registry={customCatalogRegistry}>
      {['s', 'custom'].map(surfaceId => <A2UIActivityMessage key={surfaceId} surfaceId={surfaceId}
        messages={messages} disabled={disabled}
        onAction={disabled ? undefined : action => { probe.actions.push(action); }} />)}
    </A2uiCatalogProvider>);
  },
  surfaces(messages: Messages) {
    root.render(<InteractionA2uiSurface a2ui={presentation(messages)} disabled={false}
      onSubmit={value => { probe.actions.push(value); }} onCancel={() => { probe.actions.push('cancel'); }} />);
  },
  approval(messages: Messages, withActivity = true) {
    const active = record(messages, 'approval', 'approval');
    root.render(<>{withActivity ? <A2UIActivityMessage surfaceId="s" messages={messages} boundInteraction={active}
      onAction={action => { probe.actions.push(action); }} /> : null}
    <InteractionTray interactions={[active]} activeIndex={0} onSelectIndex={() => {}}
      onRespond={action => { probe.actions.push(action); }} localCatalog={a2uiCatalog} /></>);
  },
  approvalHistoryOnly(messages: Messages) {
    const interaction = { ...record(messages, 'approval-history', 'approval'), status: 'resolved' as const, outcome: 'approved' };
    root.render(<ChatMessageList agentName="Review" isMobile={false} isStreaming={false} activity={null} contextIndicator={null}
      messages={[{ id: 'only-activity', runId: 'run', role: 'a2ui', content: '', timestamp: 1,
        aguiActivity: { surfaceId: 's', messages, interactionId: interaction.interactionId } }]}
      interactionRecords={[interaction]} scrollRef={createRef()} onOpenAttachmentPreview={() => {}}
      onRespondToApproval={() => {}} onSubmitFeedback={() => {}} onDeleteFeedback={() => {}} />);
  },
  input(messages: Messages, interactionId: string) {
    root.render(<InteractionTray interactions={[record(messages, interactionId, 'structured_input')]}
      activeIndex={0} onSelectIndex={() => {}} onRespond={action => { probe.actions.push(action); }}
      localCatalog={a2uiCatalog} />);
  },
};
declare global { interface Window { rendererProbe: typeof probe } }
window.rendererProbe = probe;
