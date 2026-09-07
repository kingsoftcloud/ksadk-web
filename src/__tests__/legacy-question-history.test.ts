import { describe, expect, it } from 'vitest';
import { legacyQuestionSummary } from '../core/run/a2ui.js';

describe('legacy native question history', () => {
  it('recovers the retired Form as readable questions', () => {
    expect(legacyQuestionSummary([{ updateComponents: { components: [
      { id: 'form', component: 'Form', children: ['q'] },
      { id: 'q', component: 'MultipleChoice', label: '范围', description: '检查哪些部分？' },
    ] } }])).toEqual(['检查哪些部分？']);
  });
  it('leaves supported custom A2UI trees alone', () => {
    expect(legacyQuestionSummary([{ updateComponents: { components: [
      { id: 'root', component: 'Column', children: ['text'] },
    ] } }])).toBeNull();
  });
});
