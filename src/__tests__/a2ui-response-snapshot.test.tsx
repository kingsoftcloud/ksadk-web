import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { A2UIActivityMessage } from '../components/chat/A2UIActivityMessage.js';
import { a2uiHistoryAnswer, projectA2uiHistoryResponse } from '../components/chat/a2ui-response-snapshot.js';
import { LegacyA2UISurface } from '../components/chat/LegacyA2UISurface.js';
import { a2uiManifest } from '../core/a2ui/catalog.js';
import { A2uiSurfaces } from '../core/a2ui/surfaces.js';
import { interactionFromSessionEvent } from '../core/interaction/adapters/session-events.js';
import type { JsonValue } from '../types/json-value.js';

const official = (entries: Record<string, unknown>[], context: Record<string, unknown> = { payload: { path: '/answer' } }) => [
  { version: 'v0.9.1', createSurface: { surfaceId: 'form', catalogId: a2uiManifest.catalog_id } },
  { version: 'v0.9.1', updateComponents: { surfaceId: 'form', components: [
    { id: 'root', component: 'Column', children: [...entries.map(component => component.id), 'submit'] },
    ...entries, { id: 'submit', component: 'Button', child: 'submit-label', action: { event: { name: 'submit', context } } },
    { id: 'submit-label', component: 'Text', text: '提交' },
  ] } },
];
const legacy = (fields: Record<string, unknown>[]) => [
  { version: 'v0.9', createSurface: { surfaceId: 'form', catalogId: 'a2ui.org/catalogs/basic/v1.0' } },
  { version: 'v0.9', updateComponents: { surfaceId: 'form', components: [
    { id: 'form-body', component: 'Form', title: '补充参数', fields },
  ] } },
];
const modelFrom = (messages: Record<string, unknown>[]) => {
  const controller = new A2uiSurfaces(() => { throw new Error('Readonly history cannot emit an action'); });
  controller.enabled = false;
  controller.apply(messages);
  return controller;
};

describe('accepted A2UI answer projection', () => {
  it('projects an explicit payload base and preserves false, zero, empty, arrays and unrelated model data', () => {
    const messages = [...official([
      { id: 'name', component: 'TextField', label: '名称', value: { path: '/answer/name' } },
      { id: 'enabled', component: 'CheckBox', label: '开启', value: { path: '/answer/enabled' } },
      { id: 'count', component: 'Slider', max: 10, value: { path: '/answer/count' } },
      { id: 'choices', component: 'ChoicePicker', options: [{ label: 'A', value: 'a' }], value: { path: '/answer/choices' } },
    ]), { version: 'v0.9.1', updateDataModel: { surfaceId: 'form', path: '/', value: { other: 'kept', answer: { name: 'initial' } } } }];
    const original = structuredClone(messages);
    const value = { name: '', enabled: false, count: 0, choices: ['a'] };
    const result = projectA2uiHistoryResponse('form', messages, { type: 'object' }, value);
    expect(result.mapped).toBe(true);
    const controller = modelFrom(result.messages);
    try {
      expect(controller.get('form')?.dataModel.get('/answer')).toEqual(value);
      expect(controller.get('form')?.dataModel.get('/other')).toBe('kept');
    } finally { controller.dispose(); }
    expect(messages).toEqual(original);
  });

  it.each([false, 0, '', null, []] as JsonValue[])('supports a root JSON answer %j without assuming field names', value => {
    const messages = official([{ id: 'field', component: 'TextField', label: '答案', value: { path: '/submitted' } }],
      { payload: { path: '/submitted' } });
    const result = projectA2uiHistoryResponse('form', messages, {}, value);
    const controller = modelFrom(result.messages);
    try {
      if (value === null) {
        // Official updateDataModel(null) deletes a binding; the display-only
        // component replacement represents a submitted null explicitly.
        expect(result.answer.summary).toBeNull();
        expect(JSON.stringify(result.messages.at(-1))).toContain('答案：null');
      } else expect(controller.get('form')?.dataModel.get('/submitted')).toEqual(value);
    }
    finally { controller.dispose(); }
  });

  it('projects explicit context fields using escaped nested JSON pointer bindings', () => {
    const messages = official([
      { id: 'field', component: 'TextField', label: '路径字段', value: { path: '/draft/a~1b/~0name' } },
    ], { 'custom/key': { path: '/draft/a~1b' } });
    const result = projectA2uiHistoryResponse('form', messages, {}, { 'custom/key': { '~name': 'accepted' } });
    const controller = modelFrom(result.messages);
    try { expect(controller.get('form')?.dataModel.get('/draft/a~1b/~0name')).toBe('accepted'); }
    finally { controller.dispose(); }
  });

  it('renders sensitive boolean and choice fields as hidden text without false selection semantics', () => {
    const messages = official([
      { id: 'flag', component: 'CheckBox', label: '机密开关', value: { path: '/answer/flag' } },
      { id: 'secret', component: 'ChoicePicker', label: '机密选择', options: [{ label: 'A', value: 'a' }], value: { path: '/answer/secret' } },
      { id: 'nullable', component: 'TextField', label: '可空字段', value: { path: '/answer/nullable' } },
    ]);
    const schema = { type: 'object', properties: {
      flag: { type: 'boolean', writeOnly: true }, secret: { type: 'array', 'x-sensitive': true }, nullable: { type: ['string', 'null'] },
    } };
    const result = projectA2uiHistoryResponse('form', messages, schema, { flag: true, secret: ['raw-secret'], nullable: null });
    const controller = modelFrom(result.messages);
    try {
      expect(controller.get('form')?.dataModel.get('/answer')).toEqual({ flag: null, secret: null, nullable: null });
      const replacements = result.messages.at(-1)?.updateComponents as { components: Record<string, unknown>[] };
      expect(replacements.components).toEqual([
        { id: 'flag', component: 'Text', text: '机密开关：已隐藏' },
        { id: 'secret', component: 'Text', text: '机密选择：已隐藏' },
        { id: 'nullable', component: 'Text', text: '可空字段：null' },
      ]);
      expect(result.answer.summary).toEqual({ flag: '已隐藏', secret: '已隐藏', nullable: null });
    } finally { controller.dispose(); }
  });

  it('falls back for absent, relative, dangerous or conflicting action mappings', () => {
    for (const context of [{}, { payload: { path: 'relative' } }, { payload: { path: '/__proto__/polluted' } }]) {
      const messages = official([{ id: 'field', component: 'TextField', label: '答案', value: { path: '/answer/name' } }], context);
      expect(projectA2uiHistoryResponse('form', messages, {}, { name: 'safe' }).mapped).toBe(false);
    }
    const messages = official([{ id: 'field', component: 'TextField', label: '答案', value: { path: '/draft' } }],
      { a: { path: '/draft' }, b: { path: '/draft' } });
    expect(projectA2uiHistoryResponse('form', messages, {}, { a: 'one', b: 'two' }).mapped).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('does not guess which Button consumed the response or traverse unbounded context trees', () => {
    const messages = official([{ id: 'field', component: 'TextField', label: '答案', value: { path: '/answer/name' } }]);
    const ambiguous = [...messages, { version: 'v0.9.1', updateComponents: { surfaceId: 'form', components: [
      { id: 'other', component: 'Button', child: 'submit-label', action: { event: {
        name: 'submit-other', context: { payload: { path: '/other' } },
      } } },
    ] } }];
    expect(projectA2uiHistoryResponse('form', ambiguous, {}, { name: 'safe' }).mapped).toBe(false);
    let nested: Record<string, unknown> = { path: '/answer' };
    for (let i = 0; i < 60; i += 1) nested = { child: nested };
    expect(projectA2uiHistoryResponse('form', official([
      { id: 'field', component: 'TextField', label: '答案', value: { path: '/answer/name' } },
    ], { payload: nested }), {}, { name: 'safe' }).mapped).toBe(false);
  });
});

describe('legacy submitted form DOM', () => {
  it('displays accepted field values rather than defaults, with precise null and secret semantics', () => {
    const messages = legacy([
      { name: 'resource', label: '资源', type: 'string', value: 'old-resource' },
      { name: 'flag', label: '普通开关', type: 'boolean', value: true },
      { name: 'count', label: '数量', type: 'number', value: 5 },
      { name: 'empty', label: '空字符串', type: 'string', value: 'initial' },
      { name: 'nullable', label: '空值', type: 'string' },
      { name: 'secret', label: '机密开关', type: 'boolean', value: true },
    ]);
    const requested = interactionFromSessionEvent({ EventType: 'interaction.requested', SessionId: 'session', Content: {
      interaction_id: 'input', kind: 'structured_input', request_schema: { type: 'object', properties: {
        secret: { type: 'boolean', writeOnly: true },
      } }, presentation: { a2ui: { wire_version: '0.9.1', catalog_digest: 'fixture', messages } },
    } })!;
    const html = renderToStaticMarkup(<A2UIActivityMessage surfaceId="form" messages={messages}
      boundInteraction={{ ...requested, status: 'resolved', outcome: 'submitted', response: {
        resource: 'new-resource', flag: false, count: 0, empty: '', nullable: null, secret: true,
      } }} onAction={() => { throw new Error('Cannot resubmit'); }} />);
    expect(html).toContain('value="new-resource"');
    expect(html).not.toContain('old-resource');
    expect(html).toContain('value="0"');
    expect(html).not.toContain('checked=""');
    expect(html).toContain('已隐藏');
    expect(html).toContain('null');
    expect(html).not.toContain('name="secret"');
    expect(html).toContain('disabled=""');
  });

  it('restores legacy Choice selections and hides a sensitive selection', () => {
    const messages = [legacy([])[0], { version: 'v0.9', updateComponents: { surfaceId: 'form', components: [
      { id: 'choice', component: 'Select', label: '业务线', options: [{ value: 'kec', label: '云服务器' }, { value: 'ebs', label: '云盘' }] },
    ] } }];
    const selected = renderToStaticMarkup(<LegacyA2UISurface surfaceId="form" messages={messages} disabled onAction={() => {}}
      historyAnswer={a2uiHistoryAnswer({ type: 'object' }, { value: 'ebs' })} />);
    expect(selected).toContain('<option value="ebs" selected="">');
    const hidden = renderToStaticMarkup(<LegacyA2UISurface surfaceId="form" messages={messages} disabled onAction={() => {}}
      historyAnswer={a2uiHistoryAnswer({ properties: { value: { 'x-sensitive': true } } }, { value: 'ebs' })} />);
    expect(hidden).toContain('已隐藏');
    expect(hidden).not.toContain('<select');
  });

  it('does not mutate original data messages while applying nested model updates', () => {
    const messages = [...legacy([{ name: 'resource' }]),
      { version: 'v0.9', updateDataModel: { surfaceId: 'form', path: '/', value: { resource: 'old' } } },
      { version: 'v0.9', updateDataModel: { surfaceId: 'form', path: '/resource', value: 'new' } },
    ];
    const original = structuredClone(messages);
    renderToStaticMarkup(<LegacyA2UISurface surfaceId="form" messages={messages} disabled onAction={() => {}} />);
    expect(messages).toEqual(original);
  });
});
