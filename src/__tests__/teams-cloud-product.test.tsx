import { renderToStaticMarkup } from 'react-dom/server';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { CloudOperations, HttpCloudTeamsProductClient, TeamsOperationOutbox, WorkspaceReducer, type TeamsOperationTransport } from '../public/teams.js';
import { CloudTeamWorkspaceView } from '../public/team-components.js';
import { cloudTeamScope, cloudTeamSnapshot } from '../../e2e/fixtures/cloud-teams-data.js';

const scope = cloudTeamScope();
const input = { operation: `groups/${scope.groupId}/messages`, payload: { parts: [{ kind: 'text', text: '目标' }], mentions: [], intent: 'start_goal' } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const transport = (overrides: Partial<TeamsOperationTransport> = {}): TeamsOperationTransport => ({ lookup: vi.fn(async () => ({ status: 'missing' })), send: vi.fn(async () => ({ status: 'confirmed', receipt: { status: 'accepted', groupId: scope.groupId, teamRunId: 'run-a' } })), ...overrides });

describe('Cloud UI durable operation ownership', () => {
  it('restores an uncertain original key after refresh and does not enqueue identical intent twice', async () => {
    const indexedDB = new IDBFactory(); const firstTransport = transport({ send: vi.fn(async () => ({ status: 'uncertain' })) });
    const first = new CloudOperations({ scope, indexedDB }, firstTransport);
    const original = await first.submit(input); expect(original.status).toBe('uncertain'); first.dispose();
    const nextTransport = transport(); const second = new CloudOperations({ scope, indexedDB }, nextTransport);
    const recovered = await second.submit(input);
    expect(recovered.operationId).toBe(original.operationId); expect(recovered.idempotencyKey).toBe(original.idempotencyKey); expect(recovered.status).toBe('confirmed');
    expect(nextTransport.lookup).toHaveBeenCalledOnce(); expect(nextTransport.send).toHaveBeenCalledOnce(); expect((await second.outbox.list())).toHaveLength(1); second.dispose();
  });
  it('atomically reuses identical pending intent when two tabs enqueue at once', async () => {
    const indexedDB = new IDBFactory(); const first = new CloudOperations({ scope, indexedDB }, transport()); const second = new CloudOperations({ scope, indexedDB }, transport());
    const [left, right] = await Promise.all([first.enqueue(input), second.enqueue(input)]);
    expect(left.operationId).toBe(right.operationId); expect(left.idempotencyKey).toBe(right.idempotencyKey); expect(await first.outbox.list()).toHaveLength(1);
    const different = await second.enqueue({ ...input, payload: { ...input.payload, mentions: ['another-member'] } }); expect(different.operationId).not.toBe(left.operationId);
    first.dispose(); second.dispose();
  });
  it('keeps read-only queues visible without dispatching, and aborts a drain on degradation', async () => {
    const indexedDB = new IDBFactory(); const started: AbortSignal[] = [];
    const wire = transport({ lookup: vi.fn(async (_operation, signal) => { started.push(signal); return new Promise(resolve => signal.addEventListener('abort', () => resolve({ status: 'uncertain' }), { once: true })); }) });
    const session = new CloudOperations({ scope, indexedDB }, wire); await session.enqueue(input); session.setWritable(false); await session.recover(); expect(wire.lookup).not.toHaveBeenCalled(); expect(session.getSnapshot().operations).toHaveLength(1);
    await expect(session.enqueue(input)).rejects.toThrow('cloud_read_only'); session.setWritable(true); const recovering = session.recover(); await vi.waitFor(() => expect(started).toHaveLength(1)); session.setWritable(false); await recovering; expect(started[0].aborted).toBe(true); expect(wire.send).not.toHaveBeenCalled(); session.dispose();
  });
  it('retains unresolved intent beyond the first 100 stored operations', async () => {
    const session = new CloudOperations({ scope, indexedDB: new IDBFactory() }, transport());
    for (let index = 0; index < 101; index++) await session.outbox.enqueue({ ...input, payload: { ...input.payload, message: String(index) } });
    const payload = { ...input.payload, message: '100' };
    const last = (await session.outbox.list({ limit: 1000 })).at(-1)!;
    const same = await session.enqueue({ ...input, payload });
    expect(same.operationId).toBe(last.operationId); expect(session.getSnapshot().operations).toHaveLength(101); session.dispose();
  });
  it('does not recover another owner scope', async () => {
    const indexedDB = new IDBFactory(); const wire = transport(); const first = new CloudOperations({ scope, indexedDB }, wire); await first.enqueue(input); first.dispose();
    const next = new CloudOperations({ scope: { ...scope, ownerScopeRef: 'other-owner' }, indexedDB }, wire); await next.recover(); expect(wire.lookup).not.toHaveBeenCalled(); expect(next.getSnapshot().operations).toEqual([]); next.dispose();
  });
});

describe('Authenticated cloud product adapter', () => {
  it('rejects digest mismatch and never interprets an HTTP 404 as missing', async () => {
    const outbox = new TeamsOperationOutbox({ scope, indexedDB: new IDBFactory() }); const operation = await outbox.enqueue(input);
    const fetcher = vi.fn(async () => json({ status: 'confirmed', operationId: 'server-op', payloadDigest: `sha256:${'0'.repeat(64)}`, receipt: { status: 'accepted', groupId: scope.groupId, teamRunId: 'run-a' } }));
    const product = new HttpCloudTeamsProductClient({ origin: scope.origin, fetch: fetcher });
    await expect(product.lookup(operation, new AbortController().signal)).rejects.toThrow('原始意图');
    fetcher.mockImplementation(async () => json({ error: { code: 'not_found' } }, 404)); await expect(product.lookup(operation, new AbortController().signal)).rejects.toMatchObject({ status: 404 }); await outbox.close();
  });
  it('sends only allowlisted original payload and rejects a foreign scope', async () => {
    const outbox = new TeamsOperationOutbox({ scope, indexedDB: new IDBFactory() }); const operation = await outbox.enqueue(input); const fetcher = vi.fn(async () => json({ status: 'confirmed', operationId: 'server-op', payloadDigest: operation.payloadDigest, receipt: { status: 'accepted', groupId: scope.groupId, teamRunId: 'run-a' } }));
    const product = new HttpCloudTeamsProductClient({ origin: scope.origin, fetch: fetcher }); const result = await product.send(operation, new AbortController().signal); expect(result.status).toBe('confirmed');
    const call = fetcher.mock.calls[0] as unknown as [string, RequestInit]; expect(call[0]).toBe(`${scope.origin}/api/v1/groups/${scope.groupId}/messages`);
    expect(call[1]).toMatchObject({ redirect: 'error', credentials: 'same-origin', cache: 'no-store', headers: { 'X-Teams-Authority-Id': scope.authorityId, 'X-Teams-Owner-Scope-Ref': scope.ownerScopeRef } }); expect(JSON.parse(call[1].body as string)).toEqual({ ...input.payload, idempotencyKey: operation.idempotencyKey });
    await expect(product.send({ ...operation, operation: `groups/${scope.groupId}/../../secrets` }, new AbortController().signal)).rejects.toThrow(); await expect(product.send({ ...operation, scope: { ...scope, origin: 'https://other.example' } }, new AbortController().signal)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledOnce(); await outbox.close();
  });
  it('strictly decodes scoped binding pages and refuses credentials or foreign rows', async () => {
    const snapshot = cloudTeamSnapshot(); const member = snapshot.members[0];
    const body = { apiVersion: snapshot.apiVersion, scope: { authorityId: scope.authorityId, ownerScopeRef: scope.ownerScopeRef }, items: [{ ...member.binding, name: member.name, authorityRef: scope.authorityId, revision: 1 }], nextCursor: null };
    const fetcher = vi.fn(async () => json(body)); const product = new HttpCloudTeamsProductClient({ origin: scope.origin, fetch: fetcher });
    expect((await product.bindings(scope, new AbortController().signal)).items[0].name).toBe(member.name);
    fetcher.mockImplementation(async () => json({ ...body, scope: { ...body.scope, ownerScopeRef: 'other' } })); await expect(product.bindings(scope, new AbortController().signal)).rejects.toMatchObject({ code: 'scope_mismatch' });
    fetcher.mockImplementation(async () => json({ ...body, items: [{ ...body.items[0], authorityRef: 'another-authority' }] })); await expect(product.bindings(scope, new AbortController().signal)).rejects.toMatchObject({ code: 'scope_mismatch' });
    fetcher.mockImplementation(async () => json({ ...body, items: [{ ...body.items[0], token: 'must-not-be-returned' }] })); await expect(product.bindings(scope, new AbortController().signal)).rejects.toThrow();
    fetcher.mockImplementation(async () => json({ ...body, nextCursor: 'same' })); await expect(product.bindings(scope, new AbortController().signal, 'same')).rejects.toMatchObject({ code: 'cloud_contract_mismatch' });
  });
  it('binds artifact downloads to expected authenticated owner and selected run', () => {
    const product = new HttpCloudTeamsProductClient({ origin: scope.origin });
    const url = new URL(product.artifactUrl(scope, 'artifact-a', 'run-a'));
    expect(Object.fromEntries(url.searchParams)).toEqual({ expectAuthorityId: scope.authorityId, expectOwnerScopeRef: scope.ownerScopeRef, teamRunId: 'run-a' });
    expect(url.origin).toBe(scope.origin);
    expect(() => product.artifactUrl(scope, 'artifact-a', '')).toThrow();
  });
  it('strictly scopes effect pages and retains empty pages with advancing cursors', async () => {
    const effect = { effectKey: 'effect-a', groupId: scope.groupId, teamRunId: 'run-a', toolName: 'counter', effectClass: 'external_reconcilable', phase: 'unknown', revision: 3, evidenceDigest: `sha256:${'0'.repeat(64)}`, resolution: null, resolutionConflict: false, outcome: null };
    const body = { scope: { authorityId: scope.authorityId, ownerScopeRef: scope.ownerScopeRef, groupId: scope.groupId }, teamRunId: 'run-a', items: [effect], nextCursor: null };
    const fetcher = vi.fn(async () => json(body)); const product = new HttpCloudTeamsProductClient({ origin: scope.origin, fetch: fetcher });
    expect((await product.effects(scope, 'run-a', new AbortController().signal)).items[0].toolName).toBe('counter');
    fetcher.mockImplementation(async () => json({ ...body, items: [], nextCursor: 42 }));
    expect(await product.effects(scope, 'run-a', new AbortController().signal)).toMatchObject({ items: [], nextCursor: 42 });
    await expect(product.effects(scope, 'run-a', new AbortController().signal, 42)).rejects.toMatchObject({ code: 'cloud_contract_mismatch' });
    for (const changes of [{ teamRunId: 'other-run' }, { groupId: 'other-group' }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { token: 'secret' }]) {
      fetcher.mockImplementation(async () => json({ ...body, items: [{ ...effect, ...changes }] }));
      await expect(product.effects(scope, 'run-a', new AbortController().signal)).rejects.toThrow();
    }
    fetcher.mockImplementation(async () => json({ ...body, scope: { ...body.scope, ownerScopeRef: 'other-owner' } }));
    await expect(product.effects(scope, 'run-a', new AbortController().signal)).rejects.toMatchObject({ code: 'scope_mismatch' });
    fetcher.mockImplementation(async () => json({ error: { code: 'effects_unavailable' } }, 503));
    await expect(product.effects(scope, 'run-a', new AbortController().signal)).rejects.toMatchObject({ code: 'effects_unavailable' });
  });
  it('reconciles through the original operation key and rejects receipts for another effect', async () => {
    const outbox = new TeamsOperationOutbox({ scope, indexedDB: new IDBFactory() });
    const operation = await outbox.enqueue({ operation: `groups/${scope.groupId}/effects/effect-a/reconcile`, payload: { expectedRevision: 3, expectedEvidenceDigest: `sha256:${'0'.repeat(64)}`, decision: 'accept_risk', evidenceRef: 'manual-review:a', reason: 'Verified external account' } });
    const receipt = { status: 'accepted', groupId: scope.groupId, teamRunId: 'run-a', effectKey: 'effect-a', phase: 'resolved', revision: 4, resolutionId: 'resolution-a', decision: 'accept_risk', evidenceDigest: `sha256:${'0'.repeat(64)}` };
    const result = { status: 'confirmed', operationId: 'server-operation', payloadDigest: operation.payloadDigest, receipt };
    const fetcher = vi.fn(async () => json(result)); const product = new HttpCloudTeamsProductClient({ origin: scope.origin, fetch: fetcher });
    expect((await product.send(operation, new AbortController().signal)).status).toBe('confirmed');
    const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toContain(`/effects/effect-a/reconcile`); expect(JSON.parse(call[1].body as string)).toEqual({ ...operation.payload, idempotencyKey: operation.idempotencyKey });
    expect((await product.lookup(operation, new AbortController().signal)).status).toBe('confirmed');
    fetcher.mockImplementation(async () => json({ ...result, receipt: { ...receipt, effectKey: 'effect-b' } }));
    await expect(product.lookup(operation, new AbortController().signal)).rejects.toMatchObject({ code: 'scope_mismatch' });
    await outbox.close();
  });
  it('requires the directory identity and rejects an approval detail with another revision', async () => {
    const snapshot = cloudTeamSnapshot(); const fetcher = vi.fn(async () => json({ apiVersion: snapshot.apiVersion, scope: { authorityId: scope.authorityId, ownerScopeRef: 'wrong-owner' }, items: [], nextCursor: null })); const product = new HttpCloudTeamsProductClient({ origin: scope.origin, fetch: fetcher });
    await expect(product.list(scope, new AbortController().signal)).rejects.toThrow('其他身份'); const summary = snapshot.pendingInteractions[0]; fetcher.mockImplementation(async () => json({ ...summary, revision: 2, message: '内容', requestSchema: null })); await expect(product.interaction(scope, summary, new AbortController().signal)).rejects.toThrow('审批已更新');
  });
});

it('renders cloud partial data as its own view and exposes degradation without write actions', () => {
  const projection = new WorkspaceReducer(cloudTeamSnapshot()).projection();
  const markup = renderToStaticMarkup(<CloudTeamWorkspaceView observation={{ scope, selectedRunId: 'run-a', projection, connection: 'reconnecting', draft: 'saved', errorCode: null, loadingPages: [] }} canWrite={false} onRetry={() => {}} onLoadMore={() => {}} onChooseRun={() => {}} onNewGoal={() => {}} onControl={() => {}} />);
  expect(markup).toContain('正在恢复连接'); expect(markup).toContain('只读'); expect(markup).toContain('查看更早的消息'); expect(markup).toContain('role="tablist"'); expect(markup).toContain('disabled=""'); expect(markup).not.toContain('team-graph-node');
});
