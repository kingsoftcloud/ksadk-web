import { File } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { CloudMaterialUpload, verifyCloudMaterial, type CloudMaterial, type CloudMaterialPort } from '../core/teams/cloudMaterials.js';
import { HttpCloudTeamsProductClient } from '../core/teams/cloudProductClient.js';
import { digestTeamsJson } from '../core/teams/cloudCanonical.js';
import { teamsMaterialManifestDigest, type TeamsMaterialManifest } from '../core/teams/cloudContracts.js';
import { cloudTeamScope } from '../../e2e/fixtures/cloud-teams-data.js';

const scope = cloudTeamScope();
const file = (name = 'report.txt', text = 'exact material bytes') => new File([text], name, { type: 'text/plain' }) as globalThis.File;
async function material(manifest: TeamsMaterialManifest): Promise<CloudMaterial> {
  const manifestDigest = await teamsMaterialManifestDigest(manifest);
  return { materialId: `tm_${(await digestTeamsJson([scope.authorityId, manifestDigest])).slice(7)}`, manifestDigest, manifest, sizeBytes: manifest.entries.reduce((sum, entry) => sum + entry.sizeBytes, 0), state: 'pending' };
}
function port(): CloudMaterialPort {
  return {
    createMaterial: vi.fn(async (_scope, input) => material({ kind: input.kind, entries: input.entries })),
    uploadMaterialBlob: vi.fn(async () => undefined),
    finalizeMaterial: vi.fn(async (_scope, value) => ({ ...value, state: 'ready' })),
  };
}
describe('Cloud material upload ownership and immutable receipts', () => {
  it('hashes actual bytes, deduplicates content and binds only a verified ready manifest', async () => {
    const wire = port(); const upload = new CloudMaterialUpload(wire, scope);
    await upload.select([file('first.txt'), file('same.txt')]);
    const value = upload.getSnapshot(); expect(value.state).toBe('ready');
    expect(wire.uploadMaterialBlob).toHaveBeenCalledOnce(); expect(value.material?.manifest.entries).toHaveLength(2);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('exact material bytes'));
    const expected = `sha256:${Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('')}`;
    expect(value.material?.manifest.entries.every(entry => entry.digest === expected)).toBe(true);
    expect(await verifyCloudMaterial(value.material, scope)).toEqual(value.material);
  });
  it('reuses original create/finalize keys after the final receipt is lost', async () => {
    const wire = port(); let lost = true;
    wire.finalizeMaterial = vi.fn(async (_scope, value) => { if (lost) { lost = false; throw new TypeError('receipt lost'); } return { ...value, state: 'ready' }; });
    const upload = new CloudMaterialUpload(wire, scope); await upload.select([file()]);
    expect(upload.getSnapshot().state).toBe('failed'); expect(upload.getSnapshot().material).toBeNull();
    await upload.retry(); expect(upload.getSnapshot().state).toBe('ready');
    const creates = vi.mocked(wire.createMaterial).mock.calls; const finals = vi.mocked(wire.finalizeMaterial).mock.calls;
    expect(creates[0][1]).toEqual(creates[1][1]); expect(finals[0][2]).toBe(finals[1][2]);
  });
  it.each([['../secret.txt'], ['same.txt', 'same.txt']])('rejects unsafe or colliding paths before sending %j', async (...names) => {
    const wire = port(); const upload = new CloudMaterialUpload(wire, scope);
    await upload.select(names.map(name => file(name))); expect(upload.getSnapshot().state).toBe('failed');
    expect(wire.createMaterial).not.toHaveBeenCalled();
  });
  it('rejects file limits before allocating the file contents', async () => {
    const wire = port(); const upload = new CloudMaterialUpload(wire, scope);
    const large = file(); Object.defineProperty(large, 'size', { value: 20 * 1024 * 1024 + 1 });
    const read = vi.spyOn(large, 'arrayBuffer'); await upload.select([large]);
    expect(upload.getSnapshot().state).toBe('failed'); expect(wire.createMaterial).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });
  it('clearing a scope discards a late successful response and cancels its upload', async () => {
    const wire = port(); let finish!: (value: CloudMaterial) => void;
    let submitted!: TeamsMaterialManifest; let signal!: AbortSignal;
    wire.createMaterial = vi.fn(async (_scope, input, abort) => { submitted = { kind: input.kind, entries: input.entries }; signal = abort; return new Promise(resolve => { finish = resolve; }); });
    const upload = new CloudMaterialUpload(wire, scope); const pending = upload.select([file()]);
    await vi.waitFor(() => expect(wire.createMaterial).toHaveBeenCalledOnce());
    upload.clear(); finish({ ...await material(submitted), state: 'ready' }); await pending;
    expect(signal.aborted).toBe(true); expect(upload.getSnapshot().state).toBe('idle'); expect(upload.getSnapshot().files).toEqual([]);
    expect(wire.uploadMaterialBlob).not.toHaveBeenCalled();
  });
  it('cannot use another authority material receipt even with an identical manifest', async () => {
    const wire = port(); const original = wire.createMaterial;
    wire.createMaterial = vi.fn(async (...args) => ({ ...await original(...args), materialId: `tm_${'0'.repeat(64)}`, state: 'ready' }));
    const upload = new CloudMaterialUpload(wire, scope); await upload.select([file()]);
    expect(upload.getSnapshot().state).toBe('failed'); expect(upload.getSnapshot().material).toBeNull();
  });
  it('fixed-origin HTTP sends real binary bytes and exact expected scope headers', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let created!: CloudMaterial;
    const client = new HttpCloudTeamsProductClient({ origin: scope.origin, fetch: async (url, init = {}) => {
      calls.push({ url, init });
      let body: unknown;
      if (init.method === 'PUT') {
        expect(await (init.body as Blob).text()).toBe('exact material bytes');
        body = { digest: created.manifest.entries[0].digest, sizeBytes: created.sizeBytes, state: 'ready' };
      } else if (url.endsWith('/finalize')) body = { ...created, state: 'ready' };
      else { const input = JSON.parse(init.body as string); created = await material({ kind: input.kind, entries: input.entries }); body = created; }
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    } });
    const upload = new CloudMaterialUpload(client, scope); await upload.select([file()]);
    expect(upload.getSnapshot().state).toBe('ready'); expect(calls.map(call => call.init.method)).toEqual(['POST', 'PUT', 'POST']);
    for (const call of calls) { expect(new URL(call.url).origin).toBe(scope.origin); expect(call.init.redirect).toBe('error'); expect(JSON.stringify(call.init.headers)).toContain(scope.authorityId); }
    expect((calls[1].init.headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream');
  });
});
