import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import cloudFixtures from './fixtures/teams-cloud-v1.json';
import {
  TeamsOperationDrainer, TeamsOperationOutbox, TeamsOperationOutboxError,
  type TeamsOperation, type TeamsOperationOutboxOptions, type TeamsOperationPayload,
  type TeamsOperationScope, type TeamsOperationTransport,
} from '../public/teams.js';

const scope: TeamsOperationScope = { origin: 'https://studio.example', ownerScopeRef: 'owner-a', authorityId: 'authority-a', groupId: 'group-a' };
let factory: IDBFactory;
let stores: TeamsOperationOutbox[];
let clock: number;
function store(options: Partial<TeamsOperationOutboxOptions> = {}) {
  const value = new TeamsOperationOutbox({ scope, indexedDB: factory, now: () => clock, ...options });
  stores.push(value);
  return value;
}
function input(operationId = 'op-a') {
  return { operationId, operation: 'groups/group-a/messages', payload: { intent: 'start_goal', parts: [{ text: 'Analyse the report' }], expectedRevision: 2 } };
}
function transport(overrides: Partial<TeamsOperationTransport> = {}): TeamsOperationTransport {
  return { lookup: vi.fn(async () => ({ status: 'missing' })), send: vi.fn(async () => ({ status: 'confirmed', serverOperationId: 'server-a' })), ...overrides };
}

beforeEach(() => { factory = new IDBFactory(); stores = []; clock = 1_000; });
afterEach(async () => { await Promise.all(stores.map(value => value.close())); });

describe('Teams durable operation outbox', () => {
  it('matches the shared Python JCS operation digest after a real IndexedDB round trip', async () => {
    const vector = cloudFixtures.canonicalVectors.find(item => item.name === 'outbox-envelope')!;
    const envelope = vector.value as { operation: string; payload: TeamsOperationPayload };
    const original = store();
    const row = await original.enqueue({ ...envelope, operationId: 'shared-digest' });
    expect(row.payloadDigest).toBe(vector.digest);
    await original.close();
    expect((await store().get(row.operationId))?.payloadDigest).toBe(vector.digest);
  });

  it('persists a stable key/digest and recovers JSON from a new connection', async () => {
    const first = store();
    const row = await first.enqueue(input());
    expect(row).toMatchObject({ status: 'queued', attempts: 0, revision: 1, scope });
    expect(row.payloadDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(row.idempotencyKey).toBeTruthy();
    await first.close();
    expect(await store().get(row.operationId)).toEqual(row);
  });

  it('canonicalizes object ordering and binds the digest to the business operation and revision', async () => {
    const value = store();
    const first = await value.enqueue({ ...input('a'), payload: { z: 1, a: { c: 'value', b: 2 }, expectedRevision: 1 } });
    const reordered = await value.enqueue({ ...input('b'), payload: { expectedRevision: 1, a: { b: 2, c: 'value' }, z: 1 } });
    const changed = await value.enqueue({ ...input('c'), payload: { expectedRevision: 2, a: { b: 2, c: 'value' }, z: 1 } });
    const differentOperation = await value.enqueue({ ...input('d'), operation: 'groups/group-b/messages', payload: first.payload });
    expect(first.payloadDigest).toBe(reordered.payloadDigest);
    expect(first.payloadDigest).not.toBe(changed.payloadDigest);
    expect(first.payloadDigest).not.toBe(differentOperation.payloadDigest);
  });

  it('deduplicates only identical operation identity and never silently changes intent', async () => {
    const value = store();
    const row = await value.enqueue(input());
    expect(await value.enqueue(input())).toEqual(row);
    await expect(value.enqueue({ ...input(), payload: { intent: 'stop' } })).rejects.toMatchObject({ code: 'operation_payload_conflict' });
    await expect(value.enqueue({ ...input('b'), idempotencyKey: row.idempotencyKey })).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
    await expect(value.enqueue({ ...input(), idempotencyKey: 'another-key' })).rejects.toMatchObject({ code: 'operation_payload_conflict' });
    expect(await value.get(row.operationId)).toEqual(row);
  });

  it('allows explicit CAS draft edits and rejects stale or previously claimed edits', async () => {
    const value = store();
    const row = await value.enqueue(input());
    const updated = await value.updateDraft(row.operationId, row.revision, { goal: 'new goal' });
    expect(updated.idempotencyKey).toBe(row.idempotencyKey);
    expect(updated.payloadDigest).not.toBe(row.payloadDigest);
    await expect(value.updateDraft(row.operationId, row.revision, { goal: 'stale' })).rejects.toMatchObject({ code: 'operation_revision_conflict' });
    const claim = await value.claimNext('tab-a', 1_000);
    await expect(value.updateDraft(row.operationId, claim!.revision, { goal: 'replaced' })).rejects.toMatchObject({ code: 'operation_already_sent' });
    await value.settle(claim!, { status: 'uncertain' });
    const uncertain = await value.get(row.operationId);
    await expect(value.updateDraft(row.operationId, uncertain!.revision, { goal: 'replaced' })).rejects.toMatchObject({ code: 'operation_already_sent' });
  });

  it('isolates every scope dimension and keeps old owner intent for authenticated re-entry', async () => {
    const original = await store().enqueue(input());
    for (const other of [
      { ...scope, origin: 'https://another.example' }, { ...scope, ownerScopeRef: 'owner-b' },
      { ...scope, authorityId: 'authority-b' }, { ...scope, groupId: 'group-b' },
    ]) {
      const isolated = store({ scope: other });
      expect(await isolated.get(original.operationId)).toBeUndefined();
      expect(await isolated.list()).toEqual([]);
      expect(await isolated.claimNext('tab-b', 1_000)).toBeUndefined();
      await isolated.enqueue({ ...input(), idempotencyKey: original.idempotencyKey });
    }
    expect(await store().list()).toEqual([original]);
  });

  it('never evicts unresolved intent to make room, but may evict terminal local cache', async () => {
    const value = store({ maxEntries: 2 });
    await value.enqueue(input('a'));
    await value.enqueue(input('b'));
    await expect(value.enqueue(input('c'))).rejects.toMatchObject({ code: 'outbox_capacity' });
    const claim = await value.claimNext('tab', 1_000);
    await value.settle(claim!, { status: 'confirmed' });
    await value.enqueue(input('c'));
    expect((await value.list()).map(row => row.operationId)).toEqual(['b', 'c']);
  });

  it.each(['accessToken', 'refresh_secret', 'Authorization', 'headers', 'api-key', 'token_ref', 'privateKey', 'credentials'])('rejects credential field %s even when nested', async key => {
    const value = store();
    await expect(value.enqueue({ ...input(), payload: { nested: { [key]: 'secret' } } })).rejects.toMatchObject({ code: 'credentials_not_allowed' });
    expect(await value.list()).toEqual([]);
  });

  it('rejects transport metadata and non-JSON payloads instead of silently altering their digest', async () => {
    const value = store();
    for (const payload of [{ requestId: 'request-a' }, { idempotencyKey: 'key' }, { transportTime: 1 }]) {
      await expect(value.enqueue({ ...input(), payload })).rejects.toMatchObject({ code: 'transport_metadata_not_allowed' });
    }
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    for (const payload of [{ invalid: undefined }, { invalid: NaN }, { invalid: new Date() }, { invalid: [undefined] },
      { invalid: Number.MAX_SAFE_INTEGER + 1 }, { invalid: 1e20 }, { invalid: '\ud800' }, cyclic]) {
      await expect(value.enqueue({ ...input(), payload: payload as TeamsOperationPayload })).rejects.toMatchObject({ code: 'invalid_business_payload' });
    }
    await expect(value.enqueue({ ...input(), operation: 'https://server.example/?secret=value' })).rejects.toMatchObject({ code: 'invalid_business_operation' });
    await expect(store({ maxPayloadBytes: 8 }).enqueue(input())).rejects.toMatchObject({ code: 'payload_too_large' });
  });

  it('uses serializable write transactions to give concurrent tabs one claim', async () => {
    const first = store(); const second = store();
    await first.enqueue(input());
    const claims = await Promise.all([first.claimNext('tab-a', 1_000), second.claimNext('tab-b', 1_000)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await first.get('op-a'))?.attempts).toBe(1);
  });

  it('lets a new tab claim an expired lease and fences late receipts/renewals from the old tab', async () => {
    const first = store(); const second = store();
    await first.enqueue(input());
    const oldClaim = (await first.claimNext('tab-a', 1_000))!;
    clock += 1_000;
    expect(await first.renew(oldClaim, 1_000)).toBe(false);
    const newClaim = (await second.claimNext('tab-b', 1_000))!;
    expect(newClaim.idempotencyKey).toBe(oldClaim.idempotencyKey);
    expect(newClaim.leaseToken).not.toBe(oldClaim.leaseToken);
    expect(await first.settle(oldClaim, { status: 'confirmed', serverOperationId: 'wrong' })).toBe(false);
    expect(await second.settle(newClaim, { status: 'confirmed', serverOperationId: 'correct' })).toBe(true);
    expect(await first.get('op-a')).toMatchObject({ status: 'confirmed', serverOperationId: 'correct', attempts: 2 });
  });

  it('renews a live claim without permitting another tab to acquire it at the original deadline', async () => {
    const first = store(); const second = store();
    await first.enqueue(input());
    const claim = (await first.claimNext('tab-a', 1_000))!;
    clock += 600;
    expect(await first.renew(claim, 1_000)).toBe(true);
    clock += 500;
    expect(await second.claimNext('tab-b', 1_000)).toBeUndefined();
    clock += 500;
    expect(await second.claimNext('tab-b', 1_000)).toMatchObject({ leaseOwner: 'tab-b' });
  });

  it('returns only the requested bounded state view', async () => {
    const value = store();
    await value.enqueue(input('a')); await value.enqueue(input('b'));
    const claim = (await value.claimNext('tab', 1_000))!;
    await value.settle(claim, { status: 'rejected', code: 'revision_conflict' });
    expect((await value.list({ statuses: ['queued'], limit: 1 })).map(row => row.operationId)).toEqual(['b']);
  });
});

describe('Teams operation recovery drainer', () => {
  it('looks up after reload and confirms an accepted operation without repeating the mutation', async () => {
    const first = store();
    const row = await first.enqueue(input());
    await first.claimNext('crashed-tab', 1_000);
    await first.close(); clock += 1_001;
    const resumed = store();
    const client = transport({ lookup: vi.fn(async () => ({ status: 'confirmed', serverOperationId: 'accepted-before-crash', receipt: { status: 'accepted' } })) });
    expect(await new TeamsOperationDrainer(resumed, client, 'new-tab').drain()).toMatchObject({ confirmed: 1, processed: 1 });
    expect(client.send).not.toHaveBeenCalled();
    expect(client.lookup).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: row.idempotencyKey, payloadDigest: row.payloadDigest }), expect.any(AbortSignal));
    expect(await resumed.get(row.operationId)).toMatchObject({ status: 'confirmed', serverOperationId: 'accepted-before-crash' });
  });

  it('replays the same key and byte-equivalent business intent only after definitive missing', async () => {
    const value = store(); const row = await value.enqueue(input());
    const client = transport();
    await new TeamsOperationDrainer(value, client, 'tab').drain();
    expect(client.lookup).toHaveBeenCalledOnce();
    expect(client.send).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: row.idempotencyKey, payloadDigest: row.payloadDigest, payload: row.payload }), expect.any(AbortSignal));
    expect(vi.mocked(client.lookup).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(client.send).mock.invocationCallOrder[0]);
  });

  it('keeps ambiguous submission uncertain and next lookup reconciles it without another send', async () => {
    const value = store(); await value.enqueue(input());
    const client = transport({ send: vi.fn(async () => { throw new Error('private URL/token must not be persisted'); }) });
    const drainer = new TeamsOperationDrainer(value, client, 'tab');
    expect(await drainer.drain()).toMatchObject({ processed: 1, uncertain: 1 });
    expect(await value.get('op-a')).toMatchObject({ status: 'uncertain', errorCode: 'transport_uncertain' });
    expect(JSON.stringify(await value.list())).not.toContain('private URL/token');
    vi.mocked(client.lookup).mockResolvedValue({ status: 'confirmed', serverOperationId: 'server-a' });
    expect(await drainer.drain()).toMatchObject({ confirmed: 1 });
    expect(client.send).toHaveBeenCalledOnce();
  });

  it('does not treat a failed or pending lookup as proof that submission is missing', async () => {
    const value = store(); await value.enqueue(input());
    const client = transport({ lookup: vi.fn(async () => { throw new Error('offline'); }) });
    const drainer = new TeamsOperationDrainer(value, client, 'tab');
    expect(await drainer.drain()).toMatchObject({ uncertain: 1 });
    vi.mocked(client.lookup).mockResolvedValue({ status: 'pending', serverOperationId: 'processing' });
    expect(await drainer.drain()).toMatchObject({ processed: 1, uncertain: 1 });
    expect(client.send).not.toHaveBeenCalled();
    expect(await value.get('op-a')).toMatchObject({ status: 'uncertain', serverOperationId: 'processing', errorCode: 'pending' });
  });

  it('persists authoritative rejection without retrying it', async () => {
    const value = store(); await value.enqueue(input());
    const client = transport({ send: vi.fn(async () => ({ status: 'rejected', code: 'revision_conflict' })) });
    const drainer = new TeamsOperationDrainer(value, client, 'tab');
    expect(await drainer.drain()).toMatchObject({ rejected: 1 });
    expect(await drainer.drain()).toMatchObject({ processed: 0 });
    expect(client.send).toHaveBeenCalledOnce();
  });

  it('bounds each drain and never hot-loops on the same uncertain operation', async () => {
    const value = store();
    for (let index = 0; index < 4; index++) await value.enqueue(input(`op-${index}`));
    const client = transport({ lookup: vi.fn(async () => ({ status: 'uncertain' })) });
    const drainer = new TeamsOperationDrainer(value, client, 'tab');
    expect(await drainer.drain({ maxOperations: 2 })).toMatchObject({ processed: 2, uncertain: 2 });
    expect(client.lookup).toHaveBeenCalledTimes(2);
    expect((await value.list({ statuses: ['queued'] })).length).toBe(2);
    expect(await drainer.drain({ maxOperations: 2 })).toMatchObject({ processed: 2, uncertain: 2 });
    expect((await value.list({ statuses: ['queued'] })).length).toBe(0);
  });

  it('cancels an uncooperative transport on identity change and ignores its late receipt', async () => {
    const value = store(); await value.enqueue(input());
    let resolveLookup!: (value: { status: 'missing' }) => void;
    const client = transport({ lookup: vi.fn(() => new Promise(resolve => { resolveLookup = resolve; })) });
    const drainer = new TeamsOperationDrainer(value, client, 'tab');
    const pending = drainer.drain();
    await vi.waitFor(() => expect(client.lookup).toHaveBeenCalledOnce());
    drainer.deactivate();
    expect(await pending).toMatchObject({ aborted: true, uncertain: 1 });
    resolveLookup({ status: 'missing' });
    await Promise.resolve();
    expect(client.send).not.toHaveBeenCalled();
    expect(await value.get('op-a')).toMatchObject({ status: 'uncertain', errorCode: 'aborted' });
    await expect(drainer.drain()).rejects.toMatchObject({ code: 'outbox_identity_inactive' });
    expect(await store({ scope: { ...scope, ownerScopeRef: 'new-owner' } }).list()).toEqual([]);
  });

  it('times out uncooperative requests and has an independent whole-drain deadline', async () => {
    const value = store(); await value.enqueue(input());
    const client = transport({ lookup: vi.fn(() => new Promise(() => undefined)) });
    const drainer = new TeamsOperationDrainer(value, client, 'tab');
    expect(await drainer.drain({ requestTimeoutMs: 5 })).toMatchObject({ uncertain: 1, aborted: false });
    expect(await value.get('op-a')).toMatchObject({ errorCode: 'timeout' });
    expect(await drainer.drain({ maxDurationMs: 5, requestTimeoutMs: 10_000 })).toMatchObject({ uncertain: 1, aborted: true });
    expect(client.send).not.toHaveBeenCalled();
  });

  it('uses CAS claims to avoid simultaneous active senders in two browser tabs', async () => {
    const first = store(); const second = store(); await first.enqueue(input());
    const calls: string[] = [];
    const client = transport({ send: vi.fn(async operation => { calls.push(operation.operationId); return { status: 'confirmed' }; }) });
    const results = await Promise.all([new TeamsOperationDrainer(first, client, 'a').drain(), new TeamsOperationDrainer(second, client, 'b').drain()]);
    expect(calls).toEqual(['op-a']);
    expect(results.reduce((count, result) => count + result.confirmed, 0)).toBe(1);
  });

  it('does not persist credentials returned by a buggy transport or share mutable intent with it', async () => {
    const value = store(); const row = await value.enqueue(input());
    const client = transport({ lookup: vi.fn(async operation => {
      (operation as TeamsOperation).payload.intent = 'tampered';
      return { status: 'confirmed', receipt: { accessToken: 'must-not-be-stored' } };
    }) });
    expect(await new TeamsOperationDrainer(value, client, 'tab').drain()).toMatchObject({ uncertain: 1 });
    expect((await value.get(row.operationId))?.payload).toEqual(row.payload);
    expect(JSON.stringify(await value.list())).not.toContain('must-not-be-stored');
    expect(client.send).not.toHaveBeenCalled();
  });

  it('does not start transport calls for an already cancelled drain', async () => {
    const value = store(); await value.enqueue(input());
    const client = transport(); const controller = new AbortController(); controller.abort();
    expect(await new TeamsOperationDrainer(value, client, 'tab').drain({ signal: controller.signal })).toMatchObject({ processed: 0, aborted: true });
    expect(client.lookup).not.toHaveBeenCalled();
    expect(await value.get('op-a')).toMatchObject({ status: 'queued' });
    expect(new TeamsOperationOutboxError('example').code).toBe('example');
  });
});
