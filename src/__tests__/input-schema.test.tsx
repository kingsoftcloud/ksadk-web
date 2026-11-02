import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import cases from './fixtures/input-validation.fixtures.json';
import { validateInput } from '../core/interaction/schema.js';
import { jsonValue } from '../types/json-value.js';
import { InteractionClientImpl } from '../core/interaction/client.js';
import { interactionFromAguiInterrupt } from '../core/interaction/adapters/agui.js';
import { JsonSchemaInputForm } from '../components/chat/JsonSchemaInputForm.js';

describe('Runtime/Web shared JSON Schema cases', () => {
  for (const sample of cases) it(sample.name, () => {
    for (const response of sample.valid) expect(validateInput(sample.schema, response)).toEqual({ valid: true, issues: [] });
    for (const response of sample.invalid) expect(validateInput(sample.schema, response).valid).toBe(false);
  });

  it.each([undefined, NaN, Infinity, new Date(), [undefined], { missing: undefined }])('rejects non-JSON without coercion: %s', value => {
    expect(() => jsonValue(value)).toThrow();
  });

  it('rejects cycles but accepts an acyclic shared reference', () => {
    const cyclic: unknown[] = []; cyclic.push(cyclic);
    expect(() => jsonValue(cyclic)).toThrow();
    const shared = { count: 0 };
    expect(jsonValue([shared, shared])).toEqual([{ count: 0 }, { count: 0 }]);
  });
});

describe('Generic interaction submissions', () => {
  it.each([
    { 'x-codex-is-secret': true }, { 'x-sensitive': true }, { writeOnly: true }, { format: 'password' },
  ])('masks active string controls using the declared secret annotation %j', annotation => {
    const html = renderToStaticMarkup(<JsonSchemaInputForm disabled={false} onSubmit={() => {}} onCancel={() => {}}
      schema={{ type: 'object', properties: { token: { type: 'string', ...annotation },
        custom: { type: 'string', enum: ['known'], 'x-codex-is-other': true, ...annotation },
        password: { type: 'string' } } }} />);
    expect(html.match(/type="password"/g)).toHaveLength(2);
    expect(html).toMatch(/data-testid="interaction-field-password"[^>]*type="text"/);
  });

  it.each([null, false, 0, '', [], { enabled: false, count: 0, note: null }])('preserves response %j', async response => {
    const submit = vi.fn().mockResolvedValue({ schema_version: 1, command_id: 'command', status: 'accepted' });
    const client = new InteractionClientImpl({ agentId: 'agent', interactionV1Enabled: true, submitInteraction: submit });
    client.ingest(interactionFromAguiInterrupt({ interruptId: 'wait', sessionId: 's', requestSchema: {} })!);
    await client.respond({ sessionId: 's', interactionId: 'wait', expectedRevision: 1, action: 'submit', response, idempotencyKey: 'key' });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ Response: response }));
    expect(client.store.get('s', 'wait')?.status).toBe('resolving');
  });

  it('uses the saved Schema and allows correction after local validation fails', async () => {
    const submit = vi.fn().mockResolvedValue({ schema_version: 1, command_id: 'command', status: 'accepted' });
    const client = new InteractionClientImpl({ agentId: 'agent', interactionV1Enabled: true, submitInteraction: submit });
    client.ingest(interactionFromAguiInterrupt({ interruptId: 'wait', sessionId: 's', requestSchema: { type: 'integer' } })!);
    const input = { sessionId: 's', interactionId: 'wait', expectedRevision: 1, action: 'submit' as const, idempotencyKey: 'key' };
    await client.respond({ ...input, response: false });
    expect(submit).not.toHaveBeenCalled();
    expect(client.store.get('s', 'wait')?.status).toBe('failed');
    await client.respond({ ...input, response: 0 });
    expect(submit).toHaveBeenCalledOnce();
  });

  it('does not complete an AG-UI wait when only its dispatch was accepted', async () => {
    const resume = vi.fn().mockReturnValue(true);
    const client = new InteractionClientImpl({ agentId: 'agent', submitInteraction: vi.fn(), legacyAguiResume: resume });
    client.ingest(interactionFromAguiInterrupt({ interruptId: 'wait', sessionId: 's', requestSchema: { type: 'boolean' } })!);
    await client.respond({ sessionId: 's', interactionId: 'wait', expectedRevision: 1, action: 'submit', response: false, idempotencyKey: 'key' });
    expect(resume).toHaveBeenCalledWith('wait', 'resolved', false);
    expect(client.store.get('s', 'wait')?.status).toBe('resolving');
  });

  it('requires a canonical transport for a root null answer without sending an AG-UI request', async () => {
    const resume = vi.fn();
    const client = new InteractionClientImpl({ agentId: 'agent', submitInteraction: vi.fn(), legacyAguiResume: resume });
    client.ingest(interactionFromAguiInterrupt({ interruptId: 'wait', sessionId: 's', requestSchema: {} })!);
    const result = await client.respond({ sessionId: 's', interactionId: 'wait', expectedRevision: 1,
      action: 'submit', response: null, idempotencyKey: 'key' });
    expect(result.status).toBe('rejected');
    expect(resume).not.toHaveBeenCalled();
    expect(client.store.get('s', 'wait')?.status).toBe('failed');
  });

  it('renders nested, nullable and complex Schema inputs', () => {
    const html = renderToStaticMarkup(<JsonSchemaInputForm disabled={false} onSubmit={() => {}} onCancel={() => {}}
      schema={{ type: 'object', properties: { count: { type: 'integer' }, enabled: { type: 'boolean' },
        address: { type: ['object', 'null'], properties: { name: { type: 'string' } } }, items: { type: 'array' } } }} />);
    expect(html).toContain('interaction-field-count');
    expect(html).toContain('interaction-field-enabled');
    expect(html).toContain('interaction-field-address/name');
    expect(html).toContain('设为 null');
    expect(html).toContain('<textarea');
  });
});
