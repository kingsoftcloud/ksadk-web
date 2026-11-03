import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MCP_AUTHORIZATION_CAPABILITY as capability } from '../core/mcp-authorization/contract.js';
import { interactionFromSessionEvent } from '../core/interaction/adapters/session-events.js';
import { InteractionStore } from '../core/interaction/store.js';
import { McpAuthorizationCard, authorizationErrorMessage } from '../components/chat/McpAuthorizationCard.js';
import { KernelRunEventTranslator } from '../core/stream/kernel-events.js';
import { ApiFacadeImpl } from '../core/api/facade.js';
const snapshot = { schema: 'mcp.authorization/v1' as const, capability_digest: capability.digest,
  wait_id: 'wait', run_id: 'run', config_id: 'service', revision: 2, status: 'awaiting_authorization',
  deadline: 100, scopes: ['mcp:read'], allowed_actions: ['open', 'cancel', 'query'], requires_resume: true };
const frame = { family: 'control', session_id: 'session', run_id: 'run', seq: 10, event_type: 'mcp.authorization.requested', payload: snapshot };
describe('MCP authorization extension', () => {
  it('shows the published service name and safe configuration diagnostics', () => {
    const html = renderToStaticMarkup(createElement(McpAuthorizationCard, { sessionId: 'session', snapshot: { ...snapshot,
      config_id: 'opaque-version-ref', display_name: 'cloud_resources', error: 'MCP_CLIENT_NOT_FOUND' } }));
    expect(html).toContain('cloud_resources');
    expect(html).not.toContain('opaque-version-ref');
    expect(html).toContain('重新发布配置');
    expect(authorizationErrorMessage(new Error('OAUTH_CLIENT_INCOMPATIBLE'))).toContain('客户端登记');
    expect(authorizationErrorMessage(new Error('secret-provider-response'))).not.toContain('secret-provider-response');
  });
  it('fingerprints its independent contract', () => {
    const contract = JSON.parse(readFileSync(new URL('../core/mcp-authorization/contract.json', import.meta.url), 'utf8'));
    expect(createHash('sha256').update(JSON.stringify(contract, Object.keys(contract).sort())).digest('hex')).toBe(capability.digest);
  });
  it('preserves original run for history, raw envelope and flattened Kernel stream', () => {
    const flat = { ...snapshot, ...frame, payload: undefined };
    const translator = new KernelRunEventTranslator('session');
    for (const value of [frame, { Content: { session_event: frame } }, translator.translate(flat)]) {
      const result = interactionFromSessionEvent(value, 'session')!;
      expect(result.interactionId).toBe('wait'); expect(result.runId).toBe('run');
      expect(result.kind).toBe('custom'); expect(result.status).toBe('pending');
    }
  });
  it('does not let duplicated or older events resurrect a terminal wait', () => {
    const store = new InteractionStore();
    store.upsert(interactionFromSessionEvent(frame)!);
    store.upsert(interactionFromSessionEvent({ ...frame, payload: { ...snapshot, revision: 5, status: 'resumed' } })!);
    store.upsert(interactionFromSessionEvent(frame)!);
    expect(store.get('session', 'wait')?.status).toBe('resolved');
  });
  it('renders authorization as its own action and fails closed for missing capability', () => {
    const request = vi.fn();
    const render = (digest: string) => renderToStaticMarkup(createElement(McpAuthorizationCard, {
      sessionId: 'session', request, snapshot: { ...snapshot, capability_digest: digest },
    }));
    expect(render(capability.digest)).toContain('打开授权');
    expect(render('old')).toContain('当前客户端或服务端不支持');
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects a snapshot bound to another run', () => {
    expect(interactionFromSessionEvent({ ...frame, payload: { ...snapshot, run_id: 'other' } })).toBeNull();
  });
  it('uses the instance authenticated fetch and preserves raw JSON', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ Code: 0, Data: snapshot }), { headers: { 'Content-Type': 'application/json' } }));
    const api = new ApiFacadeImpl({ fetch: fetcher, agentId: 'agent' });
    const result = await api.mcpAuthorization('CancelMcpAuthorizationWait', 'wait', 2);
    expect(result).toEqual(snapshot);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ WaitId: 'wait', ExpectedRevision: 2, AgentId: 'agent' });
  });
});
