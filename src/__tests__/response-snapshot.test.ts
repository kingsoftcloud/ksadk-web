import { describe, expect, it, vi } from 'vitest';
import { InteractionClientImpl } from '../core/interaction/client.js';
import { interactionFromSessionEvent } from '../core/interaction/adapters/session-events.js';
import { normalizeInteraction } from '../core/interaction/adapters/normalize.js';
import { InteractionStore } from '../core/interaction/store.js';
import { isSensitiveInputSchema, redactInputResponse, submittedResponse } from '../core/interaction/response-snapshot.js';
import type { JsonValue } from '../types/json-value.js';
import { projectConversationStreamForHostedUi } from '../core/conversation/hosted.js';
import type { ConversationItem, ConversationStreamResult } from '../core/conversation/types.js';

const schema = { type: 'object', properties: { answer: { type: 'string' } } };
function request() {
  return interactionFromSessionEvent({ family: 'interaction', event_type: 'interaction.requested',
    session_id: 'session', run_id: 'run', payload: { interaction_id: 'input', kind: 'structured_input',
      revision: 1, request: { request_schema: schema, presentation: { title: 'Input' } } } })!;
}
function resolved(response: { response?: unknown } = {}) {
  return interactionFromSessionEvent({ family: 'interaction', event_type: 'interaction.resolved',
    session_id: 'session', run_id: 'run', payload: { interaction_id: 'input', kind: 'structured_input',
      revision: 2, outcome: 'submitted', ...response } })!;
}

describe('consumed structured answer snapshots', () => {
  it.each([null, false, 0, '', [], { nested: null }] satisfies JsonValue[])(
    'preserves the JSON value %j through transport and reverse replay', value => {
      const store = new InteractionStore();
      store.upsert(resolved({ response: value }));
      store.upsert(request());
      store.upsert(resolved());
      const interaction = store.get('session', 'input')!;
      expect(Object.hasOwn(interaction, 'response')).toBe(true);
      expect(interaction.response).toEqual(value);
      expect(submittedResponse(interaction)).toEqual({ value });
    },
  );

  it('does not turn an unavailable answer into null or consume an accepted command', async () => {
    const client = new InteractionClientImpl({ agentId: 'agent',
      submitInteraction: vi.fn().mockResolvedValue({ schema_version: 1,
        command_id: 'cmd', status: 'accepted' }) });
    client.ingest(request());
    await client.respond({ interactionId: 'input', expectedRevision: 1, action: 'submit',
      response: { answer: 'hello' }, idempotencyKey: 'one' });
    expect(client.store.get('session', 'input')?.status).toBe('resolving');
    expect(Object.hasOwn(client.store.get('session', 'input')!, 'response')).toBe(false);
    client.ingest(resolved());
    expect(submittedResponse(client.store.get('session', 'input')!)).toBeUndefined();
  });

  it('accepts a legacy Studio terminal answer but ignores one in its request', () => {
    const legacy = interactionFromSessionEvent({ EventType: 'a2ui.action', SessionId: 'session',
      Content: { interactionId: 'input', runId: 'run', kind: 'structured_input',
        action: 'submit', revision: 2, response: false } })!;
    expect(legacy.response).toBe(false);
    const pending = normalizeInteraction({ ...request(), response: 'not consumed' });
    expect(Object.hasOwn(pending, 'response')).toBe(false);
    const store = new InteractionStore();
    store.upsert(interactionFromSessionEvent({ EventType: 'a2ui.interaction', SessionId: 'session',
      Content: { interactionId: 'legacy', runId: 'run', kind: 'form', revision: 1,
        inputSchema: schema } })!);
    store.upsert(interactionFromSessionEvent({ EventType: 'interaction.resolved', SessionId: 'session',
      Content: { interactionId: 'legacy', runId: 'run', outcome: 'submitted', revision: 2,
        data: { answer: 'legacy' } } })!);
    expect(submittedResponse(store.get('session', 'legacy')!)).toEqual({ value: { answer: 'legacy' } });
  });

  it('keeps approvals and terminal outcomes other than submitted out of form answers', () => {
    const base = { ...request(), ...resolved({ response: true }), requestSchema: schema };
    expect(submittedResponse({ ...base, kind: 'approval', outcome: 'approved' })).toBeUndefined();
    expect(submittedResponse({ ...base, status: 'cancelled', outcome: 'cancelled' })).toBeUndefined();
    expect(submittedResponse({ ...base, requestSchema: null })).toBeUndefined();
  });

  it('omits invalid JSON answer snapshots', () => {
    for (const value of [undefined, NaN, { nested: undefined }]) {
      expect(Object.hasOwn(resolved({ response: value }), 'response')).toBe(false);
    }
  });

  it.each([null, false] satisfies JsonValue[])('preserves a consumed canonical ConversationItem answer %j', value => {
    const item: ConversationItem = { apiVersion: 'conversation.ksadk.io/v1', kindVersion: 1,
      itemId: 'input', sourceEventIds: ['resolved'], sessionId: 'session', runId: 'run',
      kind: 'structured_input', operation: 'completed', lifecycle: 'completed', visibility: 'public',
      payloadSchemaRef: 'conversation.item.structured-input/v1', nativeRef: {},
      payload: { interactionId: 'input', interactionKind: 'structured_input', revision: 2,
        outcome: 'submitted', inputSchema: schema, response: value } };
    const snapshot: ConversationStreamResult = { cursor: 1, runId: 'run',
      state: { items: [item], appliedSources: [] }, presentation: { runId: 'run',
        timeline: [{ key: 'input', item, sourceItemIds: ['input'] }], output: '', reasoning: '',
        textItems: [], toolItems: [], approvalItems: [], structuredInputItems: [item],
        a2uiItems: [], artifacts: [], fallbacks: [] } };
    const interaction = projectConversationStreamForHostedUi(snapshot).interactions[0];
    expect(submittedResponse(interaction)).toEqual({ value });
    item.lifecycle = 'pending';
    expect(Object.hasOwn(projectConversationStreamForHostedUi(snapshot).interactions[0], 'response')).toBe(false);
  });

  it('only exposes the redacted consumed snapshot to history consumers', () => {
    const store = new InteractionStore();
    store.upsert({ ...request(), requestSchema: { properties: { secret: { writeOnly: true }, answer: {} } } });
    store.upsert(resolved({ response: { secret: 'private', answer: 0 } }));
    expect(submittedResponse(store.get('session', 'input')!)).toEqual({ value: { secret: null, answer: 0 } });
  });

  it('does not leak structured-input secrets through a legacy optimistic summary', async () => {
    const client = new InteractionClientImpl({ agentId: 'agent', submitInteraction: vi.fn(),
      legacyResponsesApproval: vi.fn().mockResolvedValue(true) });
    client.ingest({ ...request(), source: 'responses' });
    await client.respond({ interactionId: 'input', expectedRevision: 1, action: 'submit',
      response: { secret: 'private-summary-value' }, idempotencyKey: 'legacy' });
    expect(client.store.get('session', 'input')?.responseSummary).toBe('已提交');
    expect(Object.hasOwn(client.store.get('session', 'input')!, 'response')).toBe(false);
  });
});

describe('schema-directed immutable answer redaction', () => {
  it.each([{ writeOnly: true }, { format: 'password' }, { 'x-sensitive': true },
    { 'x-codex-is-secret': true }])('hides a declared secret %j', annotation => {
    expect(isSensitiveInputSchema(annotation)).toBe(true);
    expect(redactInputResponse(annotation, 'private')).toBeNull();
  });

  it('resolves local references, siblings and conservative alternatives without mutating input', () => {
    const root = { type: 'object', $defs: { secret: { type: 'string', writeOnly: true } }, properties: {
      visible: { type: 'string' },
      password: { $ref: '#/$defs/secret' },
      choice: { anyOf: [{ type: 'string' }, { 'x-sensitive': true }] },
      settings: { allOf: [{ properties: { token: { format: 'password' } } },
        { properties: { enabled: { type: 'boolean' } } }] },
    } };
    const value = { visible: '', password: 'secret', choice: false,
      settings: { token: 'private', enabled: false } };
    const original = JSON.stringify({ root, value });
    expect(isSensitiveInputSchema(root.properties.password, root)).toBe(true);
    expect(isSensitiveInputSchema(root)).toBe(false);
    expect(redactInputResponse(root, value)).toEqual({ visible: '', password: null,
      choice: null, settings: { token: null, enabled: false } });
    expect(JSON.stringify({ root, value })).toBe(original);
  });

  it('redacts array items, tuple positions, patterns and additional properties', () => {
    const root = { properties: {
      entries: { items: { properties: { token: { 'x-sensitive': true }, count: {} } } },
      tuple: { prefixItems: [{}, { writeOnly: true }], items: { format: 'password' } },
      mapping: { properties: { public: {} }, patternProperties: { '^secret': { writeOnly: true } },
        additionalProperties: { 'x-codex-is-secret': true } },
    } };
    expect(redactInputResponse(root, { entries: [{ token: 'x', count: 0 }],
      tuple: [false, 'x', 'y'], mapping: { public: 'ok', secretOne: 'x', another: 'x' } }))
      .toEqual({ entries: [{ token: null, count: 0 }], tuple: [false, null, null],
        mapping: { public: 'ok', secretOne: null, another: null } });
  });

  it('handles recursive refs and JSON pointer escapes, and fails closed for unresolved refs', () => {
    const recursive = { type: 'object', properties: { next: { $ref: '#' },
      token: { writeOnly: true } } };
    expect(redactInputResponse(recursive, { token: 'x', next: { token: 'y', next: null } }))
      .toEqual({ token: null, next: { token: null, next: null } });
    expect(redactInputResponse({ $defs: { 'a/b~c': { writeOnly: true } },
      $ref: '#/$defs/a~1b~0c' }, 0)).toBeNull();
    expect(redactInputResponse({ $ref: '#/$defs/missing' }, 'x')).toBeNull();
  });

  it('merges conditional and dependent schemas conservatively, including unevaluated items', () => {
    const secret = { writeOnly: true };
    const declarations = { properties: { public: {} },
      if: { properties: { conditional: secret } }, then: { properties: { thenValue: secret } },
      else: { properties: { elseValue: secret } },
      dependentSchemas: { public: { properties: { dependent: secret } } },
      dependencies: { public: { properties: { oldDependent: secret } }, irrelevant: ['public'] } };
    expect(redactInputResponse(declarations, { public: 0, conditional: 'x', thenValue: 'x',
      elseValue: 'x', dependent: 'x', oldDependent: 'x' })).toEqual({ public: 0,
      conditional: null, thenValue: null, elseValue: null, dependent: null, oldDependent: null });
    expect(redactInputResponse({ prefixItems: [{}], unevaluatedItems: secret }, ['x', 'y']))
      .toEqual([null, null]);
  });

  it.each([{ $ref: '#secret', $defs: { secret: { $anchor: 'secret' } } },
    { properties: { value: { $id: 'nested-resource', type: 'string' } } },
    { $dynamicRef: '#' }, { $recursiveRef: '#' }])('hides the complete answer for unsupported resource scope %j', declaration => {
    expect(redactInputResponse(declaration, { public: 'safe', value: 'private' })).toBeNull();
  });

  it('hides the complete answer when depth or shared node budgets are exhausted', () => {
    let value: JsonValue = 0;
    for (let depth = 0; depth < 48; depth += 1) value = { next: value };
    expect(redactInputResponse({}, value)).toEqual(value);
    expect(redactInputResponse({}, { next: value })).toBeNull();
    expect(redactInputResponse({}, Array.from({ length: 8193 }, () => 'private'))).toBeNull();
    const alternatives = { allOf: Array.from({ length: 8193 }, () => ({})) };
    expect(redactInputResponse(alternatives, 'private')).toBeNull();
    expect(isSensitiveInputSchema(alternatives)).toBe(true);
  });
});
