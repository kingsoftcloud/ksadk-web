import { File } from 'node:buffer';
import { expect, it, vi } from 'vitest';
import { CloudMaterialUpload, verifyCloudMaterial, type CloudMaterial, type CloudMaterialPort } from '../core/teams/cloudMaterials.js';
import { HttpCloudTeamsProductClient } from '../core/teams/cloudProductClient.js';
import { digestTeamsJson } from '../core/teams/cloudCanonical.js';
import { teamsMaterialManifestSchema, teamsMaterialManifestDigest, type TeamsMaterialManifest } from '../core/teams/cloudContracts.js';
import { cloudTeamScope } from '../../e2e/fixtures/cloud-teams-data.js';

const scope = cloudTeamScope();
const file = (name = 'report.txt', content = 'same bytes') => new File([content], name, { type: 'text/plain' }) as globalThis.File;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
async function receipt(raw: unknown, state: CloudMaterial['state'] = 'pending'): Promise<CloudMaterial> {
  const manifest = teamsMaterialManifestSchema.parse(raw);
  const manifestDigest = await teamsMaterialManifestDigest(manifest);
  return { materialId: `tm_${(await digestTeamsJson([scope.authorityId, manifestDigest])).slice(7)}`, manifestDigest, manifest, sizeBytes: manifest.entries.reduce((sum, entry) => sum + entry.sizeBytes, 0), state };
}
function port(): CloudMaterialPort {
  return {
    createMaterial: vi.fn(async (_scope, input) => receipt({ kind: input.kind, sourceCommit: input.sourceCommit, entries: input.entries })),
    uploadMaterialBlob: vi.fn(async () => undefined),
    finalizeMaterial: vi.fn(async (_scope, value) => ({ ...value, state: 'ready' })),
  };
}

it('keeps a new retry ready when the cancelled original create ACK arrives later', async () => {
  const wire = port(); let finish!: (value: CloudMaterial) => void;
  let original!: TeamsMaterialManifest; let firstSignal!: AbortSignal; let calls = 0;
  wire.createMaterial = vi.fn(async (_scope, input, signal) => {
    const manifest = { kind: input.kind, sourceCommit: input.sourceCommit, entries: input.entries };
    if (++calls === 1) { original = manifest; firstSignal = signal; return new Promise(resolve => { finish = resolve; }); }
    return receipt(manifest);
  });
  const upload = new CloudMaterialUpload(wire, scope);
  const originalJob = upload.select([file()]);
  await vi.waitFor(() => expect(wire.createMaterial).toHaveBeenCalledOnce());
  upload.cancel(); expect(firstSignal.aborted).toBe(true); expect(upload.getSnapshot().material).toBeNull();
  await upload.retry(); const ready = upload.getSnapshot(); expect(ready.state).toBe('ready');
  finish(await receipt(original)); await originalJob;
  expect(upload.getSnapshot()).toBe(ready);
  const requests = vi.mocked(wire.createMaterial).mock.calls;
  expect(requests[0][1]).toEqual(requests[1][1]);
  expect(wire.uploadMaterialBlob).toHaveBeenCalledOnce();
});

it('discarded files cannot start blob transfer when an old ready ACK arrives after replacement', async () => {
  const wire = port(); const creates = wire.createMaterial;
  let finish!: (value: CloudMaterial) => void; let old!: TeamsMaterialManifest;
  wire.createMaterial = vi.fn(async (...args) => {
    if (args[1].entries[0].path === 'old.txt') {
      old = { kind: args[1].kind, sourceCommit: args[1].sourceCommit, entries: args[1].entries };
      return new Promise(resolve => { finish = resolve; });
    }
    return creates(...args);
  });
  const upload = new CloudMaterialUpload(wire, scope);
  const first = upload.select([file('old.txt', 'private-old')]);
  await vi.waitFor(() => expect(wire.createMaterial).toHaveBeenCalledOnce());
  await upload.select([file('new.txt', 'public-new')]);
  finish(await receipt(old, 'ready')); await first;
  expect(upload.getSnapshot().material?.manifest.entries.map(entry => entry.path)).toEqual(['new.txt']);
  expect(wire.uploadMaterialBlob).toHaveBeenCalledOnce();
  expect(vi.mocked(wire.uploadMaterialBlob).mock.calls[0][2].path).toBe('new.txt');
});

it('a different valid ready manifest is rejected after uploading the selected bytes', async () => {
  const wire = port();
  wire.finalizeMaterial = vi.fn(async (_scope, value) => receipt({ ...value.manifest, entries: value.manifest.entries.map(entry => ({ ...entry, path: 'swapped.txt' })) }, 'ready'));
  const upload = new CloudMaterialUpload(wire, scope); await upload.select([file()]);
  expect(upload.getSnapshot().state).toBe('failed'); expect(upload.getSnapshot().material).toBeNull();
  expect(wire.uploadMaterialBlob).toHaveBeenCalledOnce();
});

it.each(['count', 'total'] as const)('rejects an excessive %s before reading a file or sending a request', async limit => {
  const wire = port(); const upload = new CloudMaterialUpload(wire, scope);
  const files = limit === 'count' ? Array.from({ length: 4097 }, (_, index) => file(`${index}.txt`)) : Array.from({ length: 4 }, (_, index) => file(`${index}.txt`));
  if (limit === 'total') for (const item of files) Object.defineProperty(item, 'size', { value: 17 * 1024 * 1024 });
  const readers = files.map(item => vi.spyOn(item, 'arrayBuffer'));
  await upload.select(files);
  expect(upload.getSnapshot().state).toBe('failed'); expect(wire.createMaterial).not.toHaveBeenCalled();
  expect(readers.every(read => read.mock.calls.length === 0)).toBe(true);
});

it('a zero-byte file is still PUT as a binary body and finalized before it becomes ready', async () => {
  const calls: RequestInit[] = []; let material!: CloudMaterial;
  const client = new HttpCloudTeamsProductClient({ origin: scope.origin, fetch: async (url, init = {}) => {
    calls.push(init);
    if (init.method === 'PUT') {
      expect(await (init.body as Blob).arrayBuffer()).toHaveProperty('byteLength', 0);
      return json({ digest: material.manifest.entries[0].digest, sizeBytes: 0, state: 'ready' });
    }
    if (url.endsWith('/finalize')) return json({ ...material, state: 'ready' });
    const input = JSON.parse(init.body as string); material = await receipt({ kind: input.kind, sourceCommit: input.sourceCommit, entries: input.entries }); return json(material);
  } });
  const upload = new CloudMaterialUpload(client, scope); await upload.select([file('empty.txt', '')]);
  expect(upload.getSnapshot().state).toBe('ready'); expect(calls.map(call => call.method)).toEqual(['POST', 'PUT', 'POST']);
  expect(upload.getSnapshot().material?.manifest.entries[0].digest).toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

it('the public HTTP client retains a git snapshot source commit during receipt verification', async () => {
  const manifest = teamsMaterialManifestSchema.parse({ kind: 'git_snapshot', sourceCommit: 'a'.repeat(40), entries: [{ path: 'a.txt', digest: `sha256:${'a'.repeat(64)}`, sizeBytes: 5, mediaType: 'text/plain' }] });
  const material = await receipt(manifest);
  const client = new HttpCloudTeamsProductClient({ origin: scope.origin, fetch: async (_url, init = {}) => {
    expect(JSON.parse(init.body as string).sourceCommit).toBe(manifest.sourceCommit); return json(material);
  } });
  expect(await client.createMaterial(scope, { ...manifest, idempotencyKey: 'git-create' }, new AbortController().signal)).toEqual(material);
});

it('HTTP finalize missing-file status remains blocked and no material reference is exposed', async () => {
  let material!: CloudMaterial;
  const client = new HttpCloudTeamsProductClient({ origin: scope.origin, fetch: async (url, init = {}) => {
    if (url.endsWith('/finalize')) return json({ materialId: material.materialId, state: 'pending', missingBlobs: material.manifest.entries.map(entry => entry.digest) });
    if (init.method === 'PUT') return json({ digest: material.manifest.entries[0].digest, sizeBytes: material.sizeBytes, state: 'ready' });
    const input = JSON.parse(init.body as string); material = await receipt({ kind: input.kind, sourceCommit: input.sourceCommit, entries: input.entries }); return json(material);
  } });
  const upload = new CloudMaterialUpload(client, scope); await upload.select([file()]);
  expect(upload.getSnapshot().state).toBe('failed'); expect(upload.getSnapshot().material).toBeNull();
  expect(upload.getSnapshot().error).toBe('服务端尚未确认所有文件，请重试原上传。');
});

it('missing-file finalize replies must reference only unique original blobs and the original material', async () => {
  const wire = port(); const upload = new CloudMaterialUpload(wire, scope); await upload.select([file()]);
  const material = upload.getSnapshot().material!;
  for (const pending of [
    { materialId: `tm_${'0'.repeat(64)}`, missingBlobs: [material.manifest.entries[0].digest] },
    { materialId: material.materialId, missingBlobs: [`sha256:${'0'.repeat(64)}`] },
    { materialId: material.materialId, missingBlobs: [] },
    { materialId: material.materialId, missingBlobs: [material.manifest.entries[0].digest, material.manifest.entries[0].digest] },
  ]) {
    const client = new HttpCloudTeamsProductClient({ origin: scope.origin, fetch: async () => json({ ...pending, state: 'pending' }) });
    await expect(client.finalizeMaterial(scope, material, 'finalize-original', new AbortController().signal)).rejects.toMatchObject({ code: 'material_identity_conflict' });
  }
});

it('same manifest proof with wrong declared total or foreign origin cannot authorize an upload', async () => {
  const wire = port(); const upload = new CloudMaterialUpload(wire, scope); await upload.select([file()]);
  const ready = upload.getSnapshot().material!;
  await expect(verifyCloudMaterial({ ...ready, sizeBytes: ready.sizeBytes + 1 }, scope)).rejects.toThrow('不一致');
  const fetch = vi.fn(); const client = new HttpCloudTeamsProductClient({ origin: scope.origin, fetch });
  await expect(client.uploadMaterialBlob({ ...scope, origin: 'https://foreign.invalid' }, ready, ready.manifest.entries[0], file(), new AbortController().signal)).rejects.toThrow('来源');
  expect(fetch).not.toHaveBeenCalled();
});
