import { describe, expect, it } from 'vitest';
import { isLegacyA2uiInput, LEGACY_SURFACE_KEY, legacyA2uiAnswer } from '../core/interaction/legacy-a2ui.js';
import type { A2UIClientEventMessage } from '../core/a2ui/catalog.js';

function messages(component: string, catalogId = 'a2ui.org/catalogs/basic/v1.0') {
  return [
    { version: 'v0.9', createSurface: { surfaceId: 'form', catalogId } },
    { version: 'v0.9', updateComponents: { surfaceId: 'form', components: [{ id: 'input', component }] } },
  ];
}
function action(context: Record<string, unknown>): A2UIClientEventMessage {
  return { userAction: { surfaceId: 'form', sourceComponentId: 'input', name: 'submit', context } };
}

describe('linked legacy input answer compatibility', () => {
  it('uses the legacy envelope only for an undeclared answer schema', () => {
    expect(isLegacyA2uiInput({ [LEGACY_SURFACE_KEY]: 'form' })).toBe(true);
    expect(isLegacyA2uiInput({})).toBe(false);
    for (const schema of [null, { type: 'integer' }, { type: 'object' }, { anyOf: [{ type: 'string' }] }]) {
      expect(isLegacyA2uiInput(schema && { [LEGACY_SURFACE_KEY]: 'form', ...schema })).toBe(false);
    }
  });
  it('preserves the legacy Form resume envelope', () => {
    expect(legacyA2uiAnswer(messages('Form'), action({ fields: 'kept' }))).toEqual({
      fields: { fields: 'kept' }, modified_data: { fields: 'kept' }, retry: true,
    });
  });
  it.each(['Select', 'RadioGroup', 'ApprovalBar'])('keeps the declared %s context unchanged', component => {
    const payload = { value: '001', confirmed: false, amount: 0 };
    expect(legacyA2uiAnswer(messages(component), action(payload))).toEqual(payload);
  });
  it('does not apply the legacy Form envelope to official or custom catalogs', () => {
    expect(legacyA2uiAnswer(messages('Form', 'custom-catalog'), action({ payload: { a: 2 } }))).toEqual({ a: 2 });
  });
  it('preserves a present null payload instead of substituting the context', () => {
    expect(legacyA2uiAnswer(messages('Select'), action({ payload: null }))).toBeNull();
  });
  it('does not confuse component ids from different surfaces', () => {
    const other = [
      { version: 'v0.9', createSurface: { surfaceId: 'other', catalogId: 'a2ui.org/catalogs/basic/v1.0' } },
      { version: 'v0.9', updateComponents: { surfaceId: 'other', components: [{ id: 'input', component: 'Form' }] } },
    ];
    expect(legacyA2uiAnswer([...messages('Select'), ...other], action({ value: 0 }))).toEqual({ value: 0 });
  });
  it('uses the current component type after an incremental update', () => {
    const updated = [...messages('Form'), messages('Select')[1]];
    expect(legacyA2uiAnswer(updated, action({ value: false }))).toEqual({ value: false });
  });
});
