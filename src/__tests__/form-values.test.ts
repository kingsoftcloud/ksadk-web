import { describe, expect, it, vi } from 'vitest';
import cases from './fixtures/form-values.json';
import { normalizeFormAnswer } from '../core/interaction/form-values.js';
import { validateInput } from '../core/interaction/schema.js';
import { InteractionClientImpl } from '../core/interaction/client.js';
import { interactionFromAguiInterrupt } from '../core/interaction/adapters/agui.js';

describe('shared Schema form adaptation', () => {
  for (const sample of cases) it(sample.name, () => {
    const schema = structuredClone(sample.schema) as Record<string, unknown>;
    const answer = structuredClone(sample.input);
    if (sample.valid) expect(normalizeFormAnswer(schema, answer)).toEqual(sample.expected);
    else expect(() => normalizeFormAnswer(schema, answer)).toThrow();
    expect(schema).toEqual(sample.schema);
    expect(answer).toEqual(sample.input);
  });

  it('keeps the standalone validator strict', () => {
    expect(validateInput({ type: 'integer' }, '3').valid).toBe(false);
  });

  it.each([true, false])('adapts before validating and dispatching, Interaction/v1=%s', async interactionV1Enabled => {
    const submit = vi.fn().mockResolvedValue({ schema_version: 1, command_id: 'c', status: 'accepted' });
    const resume = vi.fn().mockReturnValue(true);
    const client = new InteractionClientImpl({ agentId: 'agent', interactionV1Enabled,
      submitInteraction: submit, legacyAguiResume: resume });
    client.ingest(interactionFromAguiInterrupt({ interruptId: 'i', sessionId: 's', requestSchema: {
      type: 'object', properties: { count: { type: 'integer', minimum: 1 }, id: { type: 'string' } },
    } })!);
    const input = { sessionId: 's', interactionId: 'i', expectedRevision: 1, action: 'submit' as const };
    await client.respond({ ...input, response: { count: '' } });
    expect(submit).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
    const response = { count: '3', id: '00123' };
    await client.respond({ ...input, response });
    if (interactionV1Enabled) expect(submit).toHaveBeenCalledWith(expect.objectContaining({ Response: { count: 3, id: '00123' } }));
    else expect(resume).toHaveBeenCalledWith('i', 'resolved', { count: 3, id: '00123' });
    expect(response.count).toBe('3');
  });
});
