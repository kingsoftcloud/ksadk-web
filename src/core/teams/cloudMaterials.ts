import { z } from 'zod';
import { TeamsError } from './contracts.js';
import { canonicalTeamsJson, digestTeamsJson } from './cloudCanonical.js';
import { teamsMaterialCreateSchema, teamsMaterialManifestSchema, teamsMaterialManifestDigest, type TeamsMaterialCreateInput, type TeamsMaterialManifest } from './cloudContracts.js';
import type { WorkspaceClientScope } from './workspaceContracts.js';

export const CLOUD_MATERIAL_LIMITS = { fileBytes: 20 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, files: 4096, manifestBytes: 2 * 1024 * 1024 } as const;
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const cloudMaterialSchema = z.strictObject({
  materialId: z.string().regex(/^tm_[0-9a-f]{64}$/), manifestDigest: digest,
  state: z.enum(['pending', 'ready', 'expired']), sizeBytes: z.number().int().min(0).max(CLOUD_MATERIAL_LIMITS.totalBytes),
  manifest: teamsMaterialManifestSchema,
});
export const cloudMaterialMissingSchema = z.strictObject({ materialId: z.string().regex(/^tm_[0-9a-f]{64}$/), state: z.literal('pending'), missingBlobs: z.array(digest).max(CLOUD_MATERIAL_LIMITS.files) });
export const cloudMaterialBlobSchema = z.strictObject({ digest, sizeBytes: z.number().int().min(0).max(CLOUD_MATERIAL_LIMITS.fileBytes), state: z.literal('ready') });
export type CloudMaterial = z.infer<typeof cloudMaterialSchema>;
export type CloudMaterialScope = Omit<WorkspaceClientScope, 'groupId'>;
export type CloudMaterialEntry = TeamsMaterialManifest['entries'][number];
export interface CloudMaterialPort {
  createMaterial(scope: CloudMaterialScope, input: TeamsMaterialCreateInput, signal: AbortSignal): Promise<CloudMaterial>;
  uploadMaterialBlob(scope: CloudMaterialScope, material: CloudMaterial, entry: CloudMaterialEntry, file: Blob, signal: AbortSignal): Promise<void>;
  finalizeMaterial(scope: CloudMaterialScope, material: CloudMaterial, idempotencyKey: string, signal: AbortSignal): Promise<CloudMaterial>;
}

/** The Server derives this ID from authority and the immutable manifest, not from a URL supplied by the browser. */
export async function verifyCloudMaterial(raw: unknown, scope: CloudMaterialScope, expectedManifest?: TeamsMaterialManifest): Promise<CloudMaterial> {
  const material = cloudMaterialSchema.parse(raw);
  const fingerprint = await teamsMaterialManifestDigest(material.manifest);
  if (fingerprint !== material.manifestDigest
    || material.materialId !== `tm_${(await digestTeamsJson([scope.authorityId, fingerprint])).slice(7)}`
    || material.sizeBytes !== material.manifest.entries.reduce((total, entry) => total + entry.sizeBytes, 0)
    || (expectedManifest && fingerprint !== await teamsMaterialManifestDigest(expectedManifest))) {
    throw new TeamsError('material_identity_conflict', '材料回执与当前身份或所选文件不一致。');
  }
  return material;
}

export type CloudMaterialState = 'idle' | 'hashing' | 'creating' | 'uploading' | 'verifying' | 'ready' | 'failed' | 'cancelled';
export interface CloudMaterialSnapshot {
  state: CloudMaterialState;
  files: ReadonlyArray<{ name: string; size: number }>;
  completed: number;
  material: CloudMaterial | null;
  error: string;
}
type Selection = { files: File[]; createKey: string; finalizeKey: string; controller: AbortController | null };
const initial = (): CloudMaterialSnapshot => ({ state: 'idle', files: [], completed: 0, material: null, error: '' });
export const materialIsBusy = (state: CloudMaterialState) => ['hashing', 'creating', 'uploading', 'verifying'].includes(state);
const aborted = () => new DOMException('Aborted', 'AbortError');

/** Files stay in memory. Only a verified ready reference may enter the durable goal outbox. */
export class CloudMaterialUpload {
  private snapshot = initial();
  private selection: Selection | null = null;
  private listeners = new Set<() => void>();
  constructor(private readonly port: CloudMaterialPort, private readonly scope: CloudMaterialScope) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<CloudMaterialSnapshot>) { this.snapshot = { ...this.snapshot, ...patch }; for (const listener of this.listeners) listener(); }
  clear() { const previous = this.selection; this.selection = null; previous?.controller?.abort(); this.snapshot = initial(); for (const listener of this.listeners) listener(); }
  dispose() { this.clear(); this.listeners.clear(); }
  cancel() { this.selection?.controller?.abort(); if (this.selection && materialIsBusy(this.snapshot.state)) this.update({ state: 'cancelled', material: null, error: '上传已取消。重试或移除材料后再开始协作。' }); }
  async select(files: Iterable<File>) {
    this.clear();
    const picked = Array.from(files);
    if (!picked.length) return;
    const selection: Selection = { files: picked, createKey: `material-create:${crypto.randomUUID()}`, finalizeKey: `material-finalize:${crypto.randomUUID()}`, controller: null };
    this.selection = selection;
    this.update({ files: picked.map(file => ({ name: file.name, size: file.size })) });
    await this.run(selection);
  }
  async retry() { if (this.selection && !materialIsBusy(this.snapshot.state)) await this.run(this.selection); }
  private async run(selection: Selection) {
    const controller = new AbortController(); selection.controller = controller;
    const current = () => { if (controller.signal.aborted || this.selection !== selection || selection.controller !== controller) throw aborted(); };
    const timer = setTimeout(() => controller.abort(), 10 * 60_000);
    this.update({ state: 'hashing', completed: 0, error: '', material: null });
    try {
      if (selection.files.length > CLOUD_MATERIAL_LIMITS.files) throw new Error('最多选择 4096 个文件。');
      if (selection.files.some(file => file.size > CLOUD_MATERIAL_LIMITS.fileBytes)) throw new Error('单个文件不能超过 20 MiB。');
      if (selection.files.reduce((sum, file) => sum + file.size, 0) > CLOUD_MATERIAL_LIMITS.totalBytes) throw new Error('材料总大小不能超过 64 MiB。');
      // Validate all paths, sizes and collisions before any bytes or manifest leave this tab.
      const entries = selection.files.map(file => ({ path: file.name, sizeBytes: file.size, mediaType: file.type || 'application/octet-stream', digest: `sha256:${'0'.repeat(64)}` }));
      teamsMaterialManifestSchema.parse({ kind: 'files', entries });
      for (let index = 0; index < selection.files.length; index++) {
        current();
        const bytes = await selection.files[index].arrayBuffer(); current();
        const hash = await crypto.subtle.digest('SHA-256', bytes); current();
        entries[index].digest = `sha256:${Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('')}`;
        this.update({ completed: index + 1 });
      }
      const input = teamsMaterialCreateSchema.parse({ kind: 'files', entries, idempotencyKey: selection.createKey });
      if (new TextEncoder().encode(canonicalTeamsJson(input)).byteLength > CLOUD_MATERIAL_LIMITS.manifestBytes) throw new Error('文件清单超过 2 MiB，请减少文件数量或缩短文件名。');
      const manifest = teamsMaterialManifestSchema.parse({ kind: input.kind, entries: input.entries });
      this.update({ state: 'creating', completed: 0 });
      let material = await this.port.createMaterial(this.scope, input, controller.signal); current();
      material = await verifyCloudMaterial(material, this.scope, manifest); current();
      if (material.state === 'expired') throw new Error('材料已过期，请重新选择文件。');
      if (material.state !== 'ready') {
        const uploaded = new Set<string>();
        for (let index = 0; index < entries.length; index++) {
          current(); this.update({ state: 'uploading', completed: index });
          if (!uploaded.has(entries[index].digest)) {
            await this.port.uploadMaterialBlob(this.scope, material, entries[index], selection.files[index], controller.signal); current();
            uploaded.add(entries[index].digest);
          }
          this.update({ completed: index + 1 });
        }
        this.update({ state: 'verifying' });
        material = await this.port.finalizeMaterial(this.scope, material, selection.finalizeKey, controller.signal); current();
        material = await verifyCloudMaterial(material, this.scope, manifest); current();
      }
      if (material.state !== 'ready') throw new Error('服务端尚未验证全部文件，请重试原上传。');
      this.update({ state: 'ready', material });
    } catch (cause) {
      if (this.selection !== selection || selection.controller !== controller) return;
      if (controller.signal.aborted) this.update({ state: 'cancelled', material: null, error: '上传已取消或超时。重试或移除材料后再开始协作。' });
      else this.update({ state: 'failed', material: null, error: cause instanceof TeamsError ? `材料上传未完成（${cause.code}），请重试原上传。` : cause instanceof z.ZodError ? '文件名、类型或清单无效；同名文件不能同时上传。' : cause instanceof Error ? cause.message : '材料上传失败，请重试。' });
    } finally { clearTimeout(timer); if (selection.controller === controller) selection.controller = null; }
  }
}
