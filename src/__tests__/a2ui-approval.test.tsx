import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { a2uiApprovalBindings, a2uiApprovalResponse } from '../core/interaction/a2ui-approval.js';
import { a2uiCatalog, a2uiManifest, legacyA2uiCatalog, type A2UIClientEventMessage } from '../core/a2ui/catalog.js';
import { A2uiCatalogRegistry } from '../core/a2ui/registry.js';
import type { A2uiPresentation } from '../core/interaction/types.js';
import { interactionFromSessionEvent } from '../core/interaction/adapters/session-events.js';
import { InteractionTray } from '../components/chat/InteractionTray.js';

const create = (catalogId = a2uiManifest.catalog_id, surfaceId = 'plan') => ({
  version: 'v0.9.1', createSurface: { surfaceId, catalogId },
});
const update = (components: Record<string, unknown>[], surfaceId = 'plan') => ({
  version: 'v0.9.1', updateComponents: { surfaceId, components },
});
const messages = () => [create(), update([
  { id: 'root', component: 'Column', children: ['yes', 'no'] },
  { id: 'yes', component: 'Button', child: 'yes-label', action: { event: { name: 'approve' } } },
  { id: 'yes-label', component: 'Text', text: 'Run safely' },
  { id: 'no', component: 'Button', child: 'no-label', action: { event: { name: 'reject' } } },
  { id: 'no-label', component: 'Text', text: 'Do not run' },
])];
const presentation = (operations = messages()): A2uiPresentation => ({
  wireVersion: '0.9.1', catalogDigest: a2uiManifest.catalog_digest, messages: operations,
});
const event = (name = 'approve', componentId = 'yes', surfaceId = 'plan'): A2UIClientEventMessage => ({
  userAction: { name, sourceComponentId: componentId, surfaceId,
    context: { decision: 'reject', approved: false }, timestamp: new Date().toISOString() },
});
const requested = interactionFromSessionEvent({ family: 'interaction', session_id: 's',
  event_type: 'interaction.requested', payload: { interaction_id: 'wait', kind: 'approval' } })!;

describe('declared A2UI approval actions', () => {
  it('maps exact events, not button labels or returned business fields', () => {
    const bindings = a2uiApprovalBindings(presentation());
    expect(bindings).toHaveLength(2);
    expect(a2uiApprovalResponse(bindings, event())).toEqual({
      action: 'approve', response: { decision: 'approve' },
    });
    expect(a2uiApprovalResponse(bindings, event('reject', 'no'))?.action).toBe('reject');
    for (const invalid of [event('submit'), event('reject'), event('approve', 'other'),
      event('approve', 'yes', 'old-surface')]) expect(a2uiApprovalResponse(bindings, invalid)).toBeNull();
  });

  it('uses final component state and ignores deleted, orphaned or renamed actions', () => {
    const raw = messages();
    raw.push(update([{ id: 'root', component: 'Text', text: 'Replaced the buttons' }]));
    expect(a2uiApprovalBindings(presentation(raw))).toEqual([]);
    const deleted = [...messages(), { version: 'v0.9.1', deleteSurface: { surfaceId: 'plan' } }];
    expect(a2uiApprovalBindings(presentation(deleted))).toEqual([]);
    const rebuilt = [...deleted, create(), update([{ id: 'root', component: 'Text', text: 'New generation' }])];
    expect(a2uiApprovalBindings(presentation(rebuilt))).toEqual([]);
    const renamed = [...messages(), update([
      { id: 'yes', component: 'Button', child: 'yes-label', action: { event: { name: 'submit' } } },
    ])];
    expect(a2uiApprovalBindings(presentation(renamed)).map(binding => binding.action)).toEqual(['reject']);
  });

  it('works with an application catalog and a custom component using declared events', () => {
    const schema = JSON.parse(JSON.stringify(a2uiCatalog));
    schema.catalogId = schema.$id = 'urn:example:approval';
    schema.components.DecisionButton = JSON.parse(
      JSON.stringify(schema.components.Button).replaceAll('"Button"', '"DecisionButton"'),
    );
    schema.$defs.anyComponent.oneOf.push({ $ref: '#/components/DecisionButton' });
    const registry = new A2uiCatalogRegistry([{ schema, loadRenderer: async () => { throw Error('Not loaded in validation'); } }]);
    const ops = messages();
    ops[0] = create(schema.catalogId);
    const components = (ops[1].updateComponents as { components: Record<string, unknown>[] }).components;
    components.filter(component => component.component === 'Button').forEach(component => {
      component.component = 'DecisionButton';
    });
    registry.validateMessages(ops).dispose();
    expect(a2uiApprovalBindings(presentation(ops), registry)).toHaveLength(2);
  });

  it('retains the legacy ApprovalBar semantics only in its declared catalog', () => {
    const legacy = presentation([create(legacyA2uiCatalog.catalogId), update([
      { id: 'bar', component: 'ApprovalBar', approve_label: '确认执行', deny_label: '取消' },
    ])]);
    const bindings = a2uiApprovalBindings(legacy);
    expect(a2uiApprovalResponse(bindings, event('deny', 'bar'))).toEqual({
      action: 'reject', response: { decision: 'reject' },
    });
    expect(a2uiApprovalResponse(bindings, event('cancel', 'bar'))).toBeNull();
  });

  it('renders customer buttons without adding default approval buttons', () => {
    const legacy = presentation([create(legacyA2uiCatalog.catalogId), update([
      { id: 'details', component: 'Text', text: 'Real operation details' },
      { id: 'bar', component: 'ApprovalBar', approve_label: '确认执行', deny_label: '取消' },
    ])]);
    const html = renderToStaticMarkup(createElement(InteractionTray, {
      interactions: [{ ...requested, presentation: { a2ui: legacy } }], activeIndex: 0,
      onSelectIndex: () => {}, onRespond: () => {},
    }));
    expect(html).toContain('interaction-approval-a2ui');
    expect(html).toContain('确认执行');
    expect(html).not.toContain('interaction-approve"');
    expect(html).not.toContain('interaction-reject"');
    expect(html).not.toContain('interaction-a2ui-cancel');
  });

  it('fills missing decisions with default controls, keeping untyped input separate', () => {
    const onlyApprove = [...messages(), update([
      { id: 'root', component: 'Column', children: ['yes'] },
    ])];
    const html = renderToStaticMarkup(createElement(InteractionTray, {
      interactions: [{ ...requested, presentation: { a2ui: presentation(onlyApprove) } }],
      activeIndex: 0, onSelectIndex: () => {}, onRespond: () => {},
    }));
    expect(html).not.toContain('data-testid="interaction-approve"');
    expect(html).toContain('data-testid="interaction-reject"');
    const input = renderToStaticMarkup(createElement(InteractionTray, {
      interactions: [{ ...requested, kind: 'structured_input', requestSchema: {}, presentation: { a2ui: presentation() } }],
      activeIndex: 0, onSelectIndex: () => {}, onRespond: () => {},
    }));
    expect(input).not.toContain('interaction-approval-a2ui');
    expect(input).not.toContain('interaction-approve"');
  });

  it('uses default decisions and hides preview controls when no event declares approval', () => {
    const unmapped = [...messages(), update([
      { id: 'yes', component: 'Button', child: 'yes-label', action: { event: { name: 'submit' } } },
      { id: 'no', component: 'Button', child: 'no-label', action: { event: { name: 'cancel' } } },
    ])];
    expect(a2uiApprovalBindings(presentation(unmapped))).toEqual([]);
    const html = renderToStaticMarkup(createElement(InteractionTray, {
      interactions: [{ ...requested, presentation: { a2ui: presentation(unmapped) } }],
      activeIndex: 0, onSelectIndex: () => {}, onRespond: () => {},
    }));
    expect(html).toContain('[&amp;_button]:hidden');
    expect(html).toContain('data-testid="interaction-approve"');
    expect(html).toContain('data-testid="interaction-reject"');
    expect(html).not.toContain('interaction-approval-a2ui');
  });
});
