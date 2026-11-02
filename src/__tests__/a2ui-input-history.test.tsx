import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { A2UIActivityMessage } from '../components/chat/A2UIActivityMessage.js';
import { ChatMessageList } from '../components/chat/ChatMessageList.js';
import { interactionInputOutcome } from '../components/chat/approval-status.js';
import type { Message } from '../components/chat/types.js';
import type { Interaction } from '../core/interaction/types.js';
import { interactionFromSessionEvent } from '../core/interaction/adapters/session-events.js';
import { a2uiManifest } from '../core/a2ui/catalog.js';

const requested = interactionFromSessionEvent({
  family: 'interaction', session_id: 'session', event_type: 'interaction.requested',
  payload: { interaction_id: 'wait', kind: 'structured_input', title: '补充查询参数',
    message: '请选择业务线', request_schema: { type: 'object', properties: { product_group: { type: 'string' } } } },
})!;
const operations = [
  { version: 'v0.9', createSurface: { surfaceId: 'form', catalogId: 'a2ui.org/catalogs/basic/v1.0' } },
  { version: 'v0.9', updateComponents: { surfaceId: 'form', components: [
    { id: 'form-body', component: 'Form', title: '输入业务线', fields: [
      { name: 'product_group', label: '业务线', type: 'string', required: true },
    ] },
  ] } },
];
const interaction: Interaction = { ...requested, presentation: { a2ui: {
  wireVersion: '0.9.1', catalogDigest: 'fixture', messages: operations,
} } };

describe('A2UI input timeline', () => {
  it.each([
    ['resolved', 'submitted', '已提交表单'],
    ['cancelled', 'cancelled', '已取消表单'],
    ['expired', 'expired', '已过期表单'],
  ] as const)('folds %s input into an accurate read-only history entry', (status, outcome, label) => {
    const html = renderToStaticMarkup(<A2UIActivityMessage surfaceId="form" messages={operations}
      disabled boundInteraction={{ ...interaction, status, outcome, responseSummary: 'product_group=kec' }}
      onAction={() => { throw new Error('Historical input cannot submit'); }} />);
    expect(html).toContain('data-testid="a2ui-input-history"');
    expect(html).toContain(label);
    expect(html).toContain('补充查询参数');
    expect(html).toContain('请选择业务线');
    expect(html).toContain('product_group=kec');
    expect(html).not.toMatch(/<details[^>]*\sopen(?:[=>\s])/);
    expect(html).toContain('<fieldset disabled=""');
    expect(html).toContain('<button type="submit"');
    expect(html).toMatch(/<button[^>]*disabled=""/);
  });

  it.each(['pending', 'resolving', 'failed'] as const)('leaves %s input solely in the active tray', status => {
    expect(renderToStaticMarkup(<A2UIActivityMessage surfaceId="form" messages={operations}
      disabled boundInteraction={{ ...interaction, status }} />)).toBe('');
  });

  it('does not invent a submitted outcome while interaction history is loading', () => {
    const html = renderToStaticMarkup(<A2UIActivityMessage surfaceId="form" messages={operations} disabled />);
    expect(html).not.toContain('已提交');
    expect(html).not.toContain('data-testid="a2ui-input-history"');
    expect(html).toContain('<fieldset disabled=""');
  });

  it('keeps an unbound result card fully visible', () => {
    const messages = [operations[0], { version: 'v0.9', updateComponents: { surfaceId: 'form', components: [
      { id: 'result', component: 'Card', title: '查询结果', body: 'Business result' },
    ] } }];
    const html = renderToStaticMarkup(<A2UIActivityMessage surfaceId="form" messages={messages} />);
    expect(html).toContain('Business result');
    expect(html).not.toContain('<details');
    expect(html).not.toContain('a2ui-input-history');
  });

  it('preserves an Agent result replacing the same official root despite orphan input components', () => {
    const messages = [
      { version: 'v0.9.1', createSurface: { surfaceId: 'same', catalogId: a2uiManifest.catalog_id } },
      { version: 'v0.9.1', updateComponents: { surfaceId: 'same', components: [
        { id: 'root', component: 'Column', children: ['field'] },
        { id: 'field', component: 'TextField', label: 'Resource', value: { path: '/answer/resource' } },
      ] } },
    ];
    const html = renderToStaticMarkup(<A2UIActivityMessage surfaceId="same"
      messages={[...messages, { version: 'v0.9.1', updateComponents: { surfaceId: 'same', components: [
        { id: 'root', component: 'Text', text: 'Completed: resource' },
      ] } }]}
      boundInteraction={{ ...interaction, status: 'resolved', outcome: 'submitted', presentation: { a2ui: {
        wireVersion: '0.9.1', catalogDigest: 'fixture', messages,
      } } }} disabled />);
    expect(html).toContain('data-testid="a2ui-surface"');
    expect(html).not.toContain('a2ui-input-history');
  });

  it('preserves a data-only result update rather than guessing its meaning', () => {
    const html = renderToStaticMarkup(<A2UIActivityMessage surfaceId="form"
      messages={[...operations, { version: 'v0.9', updateDataModel: { surfaceId: 'form', path: '/', value: { ready: false, count: 0 } } }]}
      boundInteraction={{ ...interaction, status: 'resolved', outcome: 'submitted' }} disabled />);
    expect(html).not.toContain('a2ui-input-history');
  });

  it('still folds an effectively identical component replay', () => {
    const html = renderToStaticMarkup(<A2UIActivityMessage surfaceId="form"
      messages={[...operations, operations[1]]}
      boundInteraction={{ ...interaction, status: 'resolved', outcome: 'submitted' }} disabled />);
    expect(html).toContain('data-testid="a2ui-input-history"');
  });
});

const tool = { name: 'approval', status: 'paused' as const, args: '{}',
  approvalRequestId: 'wait', approvalStatus: 'pending' as const, approvalProtocol: 'ag-ui' as const };
function renderInputStatus(record: Interaction, blocks: boolean, status: 'paused' | 'error' | 'unknown' = 'paused') {
  const message: Message = { id: 'message', role: 'model', content: '', timestamp: 1,
    tools: { approval: { ...tool, status } },
    ...(blocks ? { blocks: [{ id: 'tool', type: 'tool' as const, toolName: 'approval', args: '{}', status,
      extra: { approvalRequestId: 'wait', approvalStatus: 'pending' } }] } : {}),
  };
  return renderToStaticMarkup(<ChatMessageList agentName="Agent" isMobile={false}
    isStreaming={false} activity={null} contextIndicator={null} messages={[message]}
    interactionRecords={[record]} scrollRef={createRef()} onOpenAttachmentPreview={() => {}}
    onRespondToApproval={() => {}} onSubmitFeedback={() => {}} onDeleteFeedback={() => {}} />);
}

describe('structured-input consumption status', () => {
  it.each([false, true])('replaces stale approval/paused snapshots without calling an answer approved (blocks=%s)', blocks => {
    const html = renderInputStatus({ ...interaction, status: 'resolved', outcome: 'submitted' }, blocks);
    expect(html).toContain('已提交');
    expect(html).toContain('补充查询参数');
    expect(html).not.toMatch(/已暂停|等待审批|等待确认|已批准|已授权|请在输入区确认面板中操作/);
  });

  it.each([false, true])('preserves an actual execution failure after the form was consumed (blocks=%s)', blocks => {
    const html = renderInputStatus({ ...interaction, status: 'resolved', outcome: 'submitted' }, blocks, 'error');
    expect(html).toMatch(/执行失败|工具调用失败/);
    expect(html).not.toMatch(/已暂停|已批准|已授权/);
  });

  it.each([false, true])('keeps an unknown execution outcome explicit after form consumption (blocks=%s)', blocks => {
    const html = renderInputStatus({ ...interaction, status: 'resolved', outcome: 'submitted' }, blocks, 'unknown');
    expect(html).toContain('状态未知');
    expect(html).not.toMatch(/已暂停|已批准|已授权/);
  });

  it('requires native consumption before declaring an answer submitted', () => {
    expect(interactionInputOutcome({ ...interaction, status: 'resolving' })).toBeUndefined();
    expect(interactionInputOutcome({ ...interaction, kind: 'approval', status: 'resolved', outcome: 'approved' })).toBeUndefined();
  });
});
