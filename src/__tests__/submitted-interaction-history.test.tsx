import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatMessageList } from '../components/chat/ChatMessageList.js';
import { A2UIActivityMessage } from '../components/chat/A2UIActivityMessage.js';
import { interactionForA2uiActivity, missingSubmittedInputHistory } from '../components/chat/submitted-interaction-history.js';
import { a2uiManifest } from '../core/a2ui/catalog.js';
import { A2uiSurfaces } from '../core/a2ui/surfaces.js';
import type { Message } from '../components/chat/types.js';
import type { Interaction } from '../core/interaction/types.js';

const interaction: Interaction = { interactionId: 'input', sessionId: 'session', runId: 'run', kind: 'structured_input',
  title: '补充资源参数', message: '请填写资源', requestSchema: { type: 'object', properties: { resource: { type: 'string' } } },
  presentation: null, response: { resource: 'accepted-resource' }, status: 'resolved', outcome: 'submitted', revision: 2,
  source: 'interaction_v1', createdAt: '2026-10-22', expiresAt: null, resolvedAt: '2026-10-22', actor: 'user',
  responseSummary: null, extensions: {},
};
const row = (id: string, runId = 'run', seq = 10): Message => ({ id, runId, role: 'model', content: 'Agent completed',
  timestamp: seq, historyOrder: { seq } });
const render = (messages: Message[], records = [interaction]) => renderToStaticMarkup(<ChatMessageList
  agentName="Agent" isMobile={false} isStreaming={false} activity={null} contextIndicator={null} messages={messages}
  interactionRecords={records} scrollRef={createRef()} onOpenAttachmentPreview={() => {}}
  onRespondToApproval={() => {}} onSubmitFeedback={() => {}} onDeleteFeedback={() => {}} />);

describe('unprojected submitted node input history', () => {
  it('renders the saved answer for a pure graph node without requiring a tool call', () => {
    const html = render([row('final')]);
    expect(html.match(/data-testid="interaction-history-anchor"/g)).toHaveLength(1);
    expect(html).toContain('accepted-resource');
    expect(html).toContain('Agent completed');
  });

  it('recovers a presentation-only legacy card once without requiring separate activity events', () => {
    const messages = [
      { version: 'v0.9', createSurface: { surfaceId: 'form', catalogId: 'a2ui.org/catalogs/basic/v1.0' } },
      { version: 'v0.9', updateComponents: { surfaceId: 'form', components: [
        { id: 'input-form', component: 'Form', fields: [{ name: 'resource', label: '资源', type: 'string' }] },
      ] } },
    ];
    const record = { ...interaction, presentation: { a2ui: { wireVersion: '0.9.1', catalogDigest: 'fixture', messages } } };
    const html = render([row('first', 'run', 5), row('final')], [record]);
    expect(html.match(/data-testid="a2ui-input-history"/g)).toHaveLength(1);
    expect(html.match(/data-testid="interaction-history-anchor"/g)).toHaveLength(1);
    expect(html).toContain('value="accepted-resource"');
    const projected = { ...row('final'), aguiActivities: [{ surfaceId: 'form', messages, interactionId: 'input' }] };
    const recovered = missingSubmittedInputHistory([projected], [record]).get('final');
    expect(recovered).toEqual([{ interaction: record, anchor: true, surfaceIds: [] }]);
    const resultActivity = { ...row('result'), aguiActivities: [{ surfaceId: 'form', messages: [] }] };
    expect(missingSubmittedInputHistory([resultActivity], [record]).get('result')?.[0]?.surfaceIds).toEqual([]);
    const anotherRun = { ...resultActivity, runId: 'older-run' };
    expect(missingSubmittedInputHistory([anotherRun, row('final')], [record]).get('final')?.[0]?.surfaceIds).toEqual(['form']);
  });

  it.each([false, true])('does not duplicate an existing tool or processing block anchor (%s)', blocks => {
    const tool = { name: 'input', args: '', status: 'completed' as const, approvalRequestId: 'input' };
    const message = { ...row('existing'), tools: { input: tool }, ...(blocks ? { blocks: [{
      id: 'input-block', type: 'tool' as const, toolName: 'input', args: '', status: 'completed' as const,
      extra: { approvalRequestId: 'input' },
    }] } : {}) };
    expect(missingSubmittedInputHistory([message], [interaction]).size).toBe(0);
    expect(render([message]).match(/data-testid="interaction-history-anchor"/g)).toHaveLength(1);
  });

  it('recovers a completed approval plan without a tool anchor, and does not duplicate existing anchors', () => {
    const record = { ...interaction, kind: 'approval' as const, outcome: 'approved', presentation: { a2ui: {
      wireVersion: '0.9.1', catalogDigest: a2uiManifest.catalog_digest, messages: [
        { version: 'v0.9', createSurface: { surfaceId: 'plan', catalogId: 'a2ui.org/catalogs/basic/v1.0' } },
        { version: 'v0.9', updateComponents: { surfaceId: 'plan', components: [{ id: 'body', component: 'Card', body: 'Restored approval plan' }] } },
      ],
    } } };
    const html = render([row('final')], [record]);
    expect(html.match(/data-testid="interaction-history-anchor"/g)).toHaveLength(1);
    expect(html.match(/Restored approval plan/g)).toHaveLength(1);
    const existing = { ...row('with-tool'), tools: { approval: { name: 'approval', args: '', status: 'completed' as const, approvalRequestId: 'input' } } };
    expect(missingSubmittedInputHistory([existing], [record]).size).toBe(0);
    expect(render([existing], [record]).match(/Restored approval plan/g)).toHaveLength(1);
  });

  it('keeps an approval on a short page containing only its A2UI Activity, after the body preview is folded', () => {
    const messages = [
      { version: 'v0.9', createSurface: { surfaceId: 'plan', catalogId: 'a2ui.org/catalogs/basic/v1.0' } },
      { version: 'v0.9', updateComponents: { surfaceId: 'plan', components: [{ id: 'body', component: 'Card', body: 'Only Activity plan' }] } },
    ];
    const record = { ...interaction, kind: 'approval' as const, outcome: 'approved', presentation: { a2ui: {
      wireVersion: '0.9.1', catalogDigest: a2uiManifest.catalog_digest, messages,
    } } };
    const activity: Message = { ...row('only-activity'), role: 'a2ui', aguiActivity: { surfaceId: 'plan', messages, interactionId: 'input' } };
    const html = render([activity], [record]);
    expect(html.match(/data-testid="interaction-history-anchor"/g)).toHaveLength(1);
    expect(html.match(/Only Activity plan/g)).toHaveLength(1);
    expect(missingSubmittedInputHistory([activity], [record]).has('only-activity')).toBe(true);
    const user = { ...row('user', 'run', 1), role: 'user' as const };
    expect([...missingSubmittedInputHistory([activity, user], [record]).keys()]).toEqual(['user']);
    expect(missingSubmittedInputHistory([activity], [{ ...record, kind: 'structured_input', outcome: 'submitted' }]).size).toBe(0);
  });

  it('uses loaded run ownership and session sequence even when metadata or rows arrive in reverse order', () => {
    const other = { ...interaction, interactionId: 'other', runId: 'other-run' };
    const messages = [row('final', 'run', 30), row('other-final', 'other-run', 20), row('early', 'run', 10)];
    const result = missingSubmittedInputHistory(messages, [other, interaction]);
    expect([...result.keys()]).toEqual(['other-final', 'final']);
    expect(result.get('final')?.map(entry => entry.interaction.interactionId)).toEqual(['input']);
    expect(missingSubmittedInputHistory([row('unrelated', 'elsewhere')], [interaction]).size).toBe(0);
    // Virtual windows render this chosen loaded row; the record is never moved
    // to an unrelated visible row when its owner lies outside the viewport.
    expect(result.has('early')).toBe(false);
  });

  it('keeps a history entry on the loaded user row if the graph emits no assistant answer', () => {
    const message = { ...row('user'), role: 'user' as const, content: 'Run business task' };
    const html = render([message]);
    expect(html).toContain('Run business task');
    expect(html).toContain('accepted-resource');
    expect(html.match(/data-testid="interaction-history-anchor"/g)).toHaveLength(1);
  });

  it('does not invent recoverable input history for pending forms, missing snapshots or old approvals', () => {
    const { response: _response, ...withoutResponse } = interaction;
    void _response;
    expect(missingSubmittedInputHistory([row('final')], [
      { ...interaction, status: 'pending', outcome: null }, withoutResponse,
      { ...interaction, kind: 'approval', outcome: 'approved' },
    ]).size).toBe(0);
  });
});

const official = [
  { version: 'v0.9.1', createSurface: { surfaceId: 'form', catalogId: a2uiManifest.catalog_id } },
  { version: 'v0.9.1', updateComponents: { surfaceId: 'form', components: [
    { id: 'root', component: 'Column', children: ['field', 'submit'] },
    { id: 'field', component: 'TextField', label: '资源', value: { path: '/answer/resource' } },
    { id: 'submit', component: 'Button', child: 'submit-label', action: { event: { name: 'submit', context: { payload: { path: '/answer' } } } } },
    { id: 'submit-label', component: 'Text', text: '提交' },
  ] } },
];
const presented: Interaction = { ...interaction,
  presentation: { a2ui: { wireVersion: '0.9.1', catalogDigest: 'fixture', messages: official } },
};

describe('same-run A2UI activity ownership', () => {
  it('keeps an initialized official input foldable after editing the active presentation', () => {
    const initial = [...official, { version: 'v0.9.1', updateDataModel: { surfaceId: 'form', path: '/',
      value: { answer: { resource: 'initial-resource' } } } }];
    const timeline = structuredClone(initial);
    const record = { ...presented, presentation: { a2ui: { ...presented.presentation!.a2ui!, messages: initial } } };
    const controller = new A2uiSurfaces(() => {});
    try {
      controller.apply(record.presentation.a2ui.messages);
      controller.get('form')!.dataModel.set('/answer/resource', 'accepted-resource');
      const html = render([{ ...row('final'), aguiActivities: [{ surfaceId: 'form', messages: timeline }] }], [record]);
      expect(html.match(/data-testid="a2ui-input-history"/g)).toHaveLength(1);
    } finally { controller.dispose(); }
  });

  it.each([false, true])('recovers the missing id on an existing official activity (%s)', standalone => {
    const activity = { surfaceId: 'form', messages: official };
    const message: Message = standalone
      ? { ...row('activity'), role: 'a2ui', aguiActivity: activity }
      : { ...row('final'), runId: undefined, invocationId: 'run', aguiActivities: [activity] };
    expect(interactionForA2uiActivity(activity, message, [presented])).toBe(presented);
    const html = render([message], [presented]);
    expect(html.match(/data-testid="a2ui-input-history"/g)).toHaveLength(1);
    expect(html).not.toContain('a2ui-input-response-fallback');
  });

  it('keeps explicit IDs authoritative and never guesses among multiple or other-run candidates', () => {
    const activity = { surfaceId: 'form' };
    expect(interactionForA2uiActivity({ ...activity, interactionId: 'wrong' }, row('final'), [presented])).toBeUndefined();
    expect(interactionForA2uiActivity(activity, row('final', 'other-run'), [presented])).toBeUndefined();
    expect(interactionForA2uiActivity(activity, row('final'), [presented, { ...presented, interactionId: 'another-input' }])).toBeUndefined();
    expect(interactionForA2uiActivity({ ...activity, interactionId: 'input' }, row('final'),
      [presented, { ...presented, interactionId: 'another-input' }])).toBe(presented);
  });

  it('binds a same-surface result without folding it back into the original input', () => {
    const result = [...official, { version: 'v0.9.1', updateComponents: { surfaceId: 'form', components: [
      { id: 'root', component: 'Text', text: 'Agent result remains visible' },
    ] } }];
    const message = { ...row('final'), aguiActivities: [{ surfaceId: 'form', messages: result }] };
    const html = render([message], [presented]);
    expect(html).toContain('data-testid="a2ui-surface"');
    // The result remains a standalone card; the original submitted form has
    // its own read-only history after that surface's content changes.
    expect(html.match(/data-testid="a2ui-input-history"/g)).toHaveLength(1);
    expect(missingSubmittedInputHistory([message], [presented]).get('final')?.[0]?.surfaceIds).toEqual(['form']);
    const resultHtml = renderToStaticMarkup(<A2UIActivityMessage surfaceId="form" messages={result}
      boundInteraction={presented} />);
    expect(resultHtml).not.toContain('data-testid="a2ui-input-history"');
    expect(resultHtml).toContain('data-testid="a2ui-surface"');
  });
});
