import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Catalog } from '@a2ui/web_core/v0_9';
import { basicCatalog } from '@a2ui/web_core/v0_9/basic_catalog';
import { createA2uiCatalogRegistry, defaultA2uiCatalogRegistry, type A2uiCatalogRegistration, type A2uiHistoryAdapter } from '../core/a2ui/registry.js';
import { A2uiCatalogProvider } from '../core/a2ui/provider.js';
import { A2uiSurfaces } from '../core/a2ui/surfaces.js';
import { A2UIActivityMessage } from '../components/chat/A2UIActivityMessage.js';
import { validateA2uiPresentation } from '../core/interaction/a2ui-validate.js';
import { a2uiAgentContext } from '../core/run/a2ui.js';
import { interactionFromSessionEvent } from '../core/interaction/adapters/session-events.js';
import schema from '../../examples/custom-catalog/catalog.json';
import { missingSubmittedInputHistory } from '../components/chat/submitted-interaction-history.js';
import type { Message } from '../components/chat/types.js';

const create = { version: 'v0.9.1', createSurface: { surfaceId: 'custom', catalogId: schema.catalogId } };
const messages = [create, { version: 'v0.9.1', updateComponents: { surfaceId: 'custom', components: [
  { id: 'root', component: 'Column', children: ['field', 'submit'] },
  { id: 'field', component: 'FeedbackInput', label: 'Feedback', value: { path: '/answer' } },
  { id: 'submit', component: 'Button', child: 'label', action: { event: { name: 'submit', context: { payload: { path: '/answer' } } } } },
  { id: 'label', component: 'Text', text: 'Send' },
] } }, { version: 'v0.9.1', updateDataModel: { surfaceId: 'custom', value: { answer: '' } } }];

function registration(loadRenderer: A2uiCatalogRegistration['loadRenderer'] = vi.fn(async () => { throw new Error('Browser loader must not run'); })) {
  return createA2uiCatalogRegistry([{ schema, loadRenderer, inputComponents: ['FeedbackInput'] }], { defaultCatalogId: schema.catalogId });
}

describe('application custom A2UI catalogs', () => {
  it('validates the custom Schema without loading renderers or changing the default registry', () => {
    const load = vi.fn(async () => { throw new Error('Must not load'); });
    const registry = registration(load);
    registry.validateMessages(messages).dispose();
    expect(load).not.toHaveBeenCalled();
    expect(defaultA2uiCatalogRegistry.get(schema.catalogId)).toBeUndefined();
    const changed = registry.get(schema.catalogId)!;
    changed.schema.components = {};
    registry.validateMessages(messages).dispose();
    expect(() => defaultA2uiCatalogRegistry.validateMessages(messages)).toThrow('未注册');
  });

  it('uses the selected custom catalog and exact digest for generation and interaction rendering', () => {
    const registry = registration();
    const presentation = { wireVersion: '0.9.1', catalogDigest: registry.get(schema.catalogId)!.digest, messages };
    expect(validateA2uiPresentation(presentation, registry)).toBe('a2ui');
    expect(validateA2uiPresentation(presentation)).toBe('json-schema-form');
    expect(validateA2uiPresentation({ ...presentation, catalogDigest: '0'.repeat(64) }, registry)).toBe('json-schema-form');
    const context = JSON.parse(a2uiAgentContext(registry).value);
    expect(context.catalogId).toBe(schema.catalogId);
    expect(context.components.FeedbackInput).toBeDefined();
    expect(context.ksadkManifest.catalog_digest).toBe(presentation.catalogDigest);
    const official = JSON.parse(a2uiAgentContext().value);
    const combined = [...messages,
      { version: 'v0.9.1', createSurface: { surfaceId: 'official', catalogId: official.catalogId } },
      { version: 'v0.9.1', updateComponents: { surfaceId: 'official', components: [
        { id: 'root', component: 'Text', text: 'Other surface' },
      ] } },
    ];
    const model = registry.validateMessages(combined);
    expect(model.getSurface('official')!.defaultCatalog.id).toBe(official.catalogId);
    expect(model.getSurface('custom')!.defaultCatalog.id).toBe(schema.catalogId);
    model.dispose();
  });

  it('renders a legacy surface from mixed catalog messages without loading unrelated renderers', () => {
    const load = vi.fn(async () => { throw new Error('Unrelated renderer must not load'); });
    const registry = registration(load);
    const legacy = [
      { version: 'v0.9', createSurface: { surfaceId: 'legacy', catalogId: 'a2ui.org/catalogs/basic/v1.0' } },
      { version: 'v0.9', updateComponents: { surfaceId: 'legacy', components: [
        { id: 'root', component: 'Form', fields: [{ name: 'region', label: 'Legacy region', type: 'string' }] },
      ] } },
    ];
    const combined = [...messages, ...legacy];
    registry.validateMessages(combined).dispose();
    const html = renderToStaticMarkup(<A2uiCatalogProvider registry={registry}>
      <A2UIActivityMessage surfaceId="legacy" messages={combined} disabled />
    </A2uiCatalogProvider>);
    expect(html).toContain('Legacy region');
    expect(html).toContain('legacy-a2ui-surface');
    expect(html).toContain('<fieldset disabled=""');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('Feedback');
    expect(load).not.toHaveBeenCalled();
  });

  it.each(['invalid-component', 'duplicate-create'])('still rejects an invalid legacy surface in mixed messages (%s)', fault => {
    const legacyCreate = { version: 'v0.9', createSurface: {
      surfaceId: 'legacy', catalogId: 'a2ui.org/catalogs/basic/v1.0',
    } };
    const invalid = fault === 'duplicate-create' ? legacyCreate : {
      version: 'v0.9', updateComponents: { surfaceId: 'legacy', components: [
        { id: 'root', component: 'UnsupportedLegacyComponent' },
      ] },
    };
    const html = renderToStaticMarkup(<A2uiCatalogProvider registry={registration()}>
      <A2UIActivityMessage surfaceId="legacy" messages={[...messages, legacyCreate, invalid]} disabled />
    </A2uiCatalogProvider>);
    expect(html).toContain('旧版卡片未通过兼容目录校验');
    expect(html).not.toContain('<input');
  });

  it('rejects conflicts, bad custom properties, missing refs and invalid batches atomically', () => {
    const registry = registration();
    const bad = structuredClone(messages);
    bad[1] = { version: 'v0.9.1', updateComponents: { surfaceId: 'custom', components: [
      { id: 'root', component: 'FeedbackInput', label: 'Bad', value: 42 },
    ] } };
    expect(() => registry.validateMessages(bad)).toThrow();
    expect(() => createA2uiCatalogRegistry([{ schema: { ...schema, title: 'conflict' }, loadRenderer: vi.fn() },
      { schema, loadRenderer: vi.fn() }])).toThrow('冲突');
    expect(() => createA2uiCatalogRegistry([{ schema, loadRenderer: vi.fn() },
      { schema, loadRenderer: vi.fn() }])).toThrow('冲突');
    expect(() => createA2uiCatalogRegistry([{ schema: { ...schema, components: {
      FeedbackInput: { $ref: 'https://example.invalid/never-fetch' },
    } }, loadRenderer: vi.fn() }])).toThrow();
  });

  it('links supplied offline references for the core while keeping the published Schema and digest', () => {
    const document = structuredClone(schema) as Record<string, unknown> & { components: Record<string, unknown> };
    const field = document.components.FeedbackInput as { allOf: Array<{ properties?: Record<string, unknown> }> };
    field.allOf.at(-1)!.properties!.label = { $ref: 'urn:example:label' };
    const registry = createA2uiCatalogRegistry([{ schema: document, resources: [{
      $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'urn:example:label', type: 'string', minLength: 1,
    }], loadRenderer: vi.fn() }]);
    registry.validateMessages(messages).dispose();
    expect(registry.get(schema.catalogId)!.schema).toEqual(document);
    const invalid = structuredClone(messages);
    invalid[1] = { version: 'v0.9.1', updateComponents: { surfaceId: 'custom', components: [
      { id: 'root', component: 'FeedbackInput', label: '' },
    ] } };
    expect(() => registry.validateMessages(invalid)).toThrow();
  });

  it('keeps custom drafts on replay and ignores actions from deleted generations', async () => {
    // A core-only test uses a supplied catalog; the real React implementation
    // is exercised separately in Chromium against the live Runtime.
    const api = Catalog.fromSchema(schema, '0.9');
    const renderer = new Catalog(schema.catalogId, '0.9', [
      ...basicCatalog.components.values(),
      { ...basicCatalog.components.get('TextField')!, name: 'FeedbackInput', schema: api.components.get('FeedbackInput')!.schema },
    ], [...basicCatalog.functions.values()]);
    const registry = registration(vi.fn(async () => renderer));
    const actions: unknown[] = [];
    const model = new A2uiSurfaces(action => actions.push(action), registry, await registry.loadRenderers([schema.catalogId]));
    try {
      model.apply(messages);
      const old = model.get('custom')!;
      old.dataModel.set('/answer', 'draft');
      model.apply(structuredClone(messages));
      expect(model.get('custom')).toBe(old);
      expect(old.dataModel.get('/answer')).toBe('draft');
      expect(() => model.apply([...messages, { version: 'v0.9.1', updateComponents: { surfaceId: 'custom', components: [
        { id: 'bad', component: 'FeedbackInput', label: 42 },
      ] } }])).toThrow();
      expect(old.dataModel.get('/answer')).toBe('draft');
      model.apply([...messages, { version: 'v0.9.1', deleteSurface: { surfaceId: 'custom' } }, ...messages]);
      await old.dispatchAction({ event: { name: 'submit', context: { payload: 'old' } } }, 'submit');
      expect(actions).toHaveLength(0);
      await model.get('custom')!.dispatchAction({ event: { name: 'submit', context: { payload: 'new' } } }, 'submit');
      expect(actions).toHaveLength(1);
    } finally { model.dispose(); }
  });

  it('keeps historical custom input read-only and redacts sensitive answers during SSR', () => {
    const registry = registration();
    const interaction = interactionFromSessionEvent({ family: 'interaction', session_id: 'session',
      event_type: 'interaction.requested', payload: { interaction_id: 'wait', kind: 'structured_input',
        request_schema: { type: 'string', writeOnly: true } } })!;
    const html = renderToStaticMarkup(<A2uiCatalogProvider registry={registry}>
      <A2UIActivityMessage surfaceId="custom" messages={messages} disabled boundInteraction={{ ...interaction,
        status: 'resolved', outcome: 'submitted', response: 'must-never-appear', presentation: { a2ui: {
          wireVersion: '0.9.1', catalogDigest: registry.get(schema.catalogId)!.digest, messages,
        } } }} />
    </A2uiCatalogProvider>);
    expect(html).toContain('a2ui-input-history');
    // SSR does not load browser components; Chromium verifies their readonly
    // fields. There is no enabled control in this server-rendered history.
    expect(html).not.toContain('<input');
    expect(html).not.toContain('must-never-appear');
  });

  it.each([false, true])('gives a history adapter only redacted answers and validates its result (%s)', invalid => {
    const adapter = vi.fn<A2uiHistoryAdapter>(({ answer }) => {
      expect(answer.value).toBeNull();
      expect(answer.summary).toBe('已隐藏');
      return { mapped: invalid, messages: invalid ? [...messages, {
        version: 'v0.9.1', updateComponents: { surfaceId: 'custom', components: [
          { id: 'root', component: 'FeedbackInput', label: 42 },
        ] },
      }] : messages };
    });
    const registry = createA2uiCatalogRegistry([{ schema, loadRenderer: vi.fn(), historyAdapter: adapter }]);
    const interaction = interactionFromSessionEvent({ family: 'interaction', session_id: 'session',
      event_type: 'interaction.requested', payload: { interaction_id: 'wait', kind: 'structured_input',
        request_schema: { type: 'string', writeOnly: true } } })!;
    const html = renderToStaticMarkup(<A2uiCatalogProvider registry={registry}>
      <A2UIActivityMessage surfaceId="custom" messages={messages} boundInteraction={{ ...interaction,
        status: 'resolved', outcome: 'submitted', response: 'must-never-appear', presentation: { a2ui: {
          wireVersion: '0.9.1', catalogDigest: registry.get(schema.catalogId)!.digest, messages,
        } } }} />
    </A2uiCatalogProvider>);
    expect(adapter).toHaveBeenCalledOnce();
    expect(html).toContain('a2ui-input-response-fallback');
    expect(html).toContain('已隐藏');
    expect(html).not.toContain('must-never-appear');
  });

  it('restores the submitted input when the same surface was updated into an Agent result', () => {
    const registry = registration();
    const requested = interactionFromSessionEvent({ family: 'interaction', session_id: 'session',
      event_type: 'interaction.requested', payload: { interaction_id: 'wait', run_id: 'run',
        kind: 'structured_input', request_schema: { type: 'string' } } })!;
    const interaction = { ...requested, runId: 'run', status: 'resolved' as const, outcome: 'submitted' as const,
      response: 'kept', presentation: { a2ui: { wireVersion: '0.9.1',
        catalogDigest: registry.get(schema.catalogId)!.digest, messages } } };
    const activity = { surfaceId: 'custom', interactionId: 'wait', messages: [...messages,
      { version: 'v0.9.1', updateComponents: { surfaceId: 'custom', components: [
        { id: 'root', component: 'Text', text: 'Agent result' },
      ] } }], catalogId: schema.catalogId };
    const rows: Message[] = [{ id: 'result', role: 'model', content: 'Completed', timestamp: 1,
      runId: 'run', aguiActivities: [activity] }];
    expect(missingSubmittedInputHistory(rows, [interaction], registry).get('result')?.[0].surfaceIds).toEqual(['custom']);
    rows[0].aguiActivities = [{ ...activity, messages }];
    expect(missingSubmittedInputHistory(rows, [interaction], registry).get('result')?.[0].surfaceIds).toEqual([]);
  });
});
