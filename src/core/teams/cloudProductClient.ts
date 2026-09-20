import { z } from 'zod';
import { TeamsError, taskSchema } from './contracts.js';
import { cloudScopeHeaders } from './cloudScope.js';
import { canonicalTeamsJson } from './cloudCanonical.js';
import { cloudEffectPageSchema, type CloudEffectPage } from './cloudEffects.js';
import { cloudMaterialBlobSchema, cloudMaterialMissingSchema, verifyCloudMaterial, type CloudMaterial, type CloudMaterialEntry, type CloudMaterialScope, type CloudMaterialPort } from './cloudMaterials.js';
import { teamsMaterialCreateSchema, type TeamsMaterialCreateInput } from './cloudContracts.js';
import type { TeamsFetch } from './client.js';
import type { TeamsOperation, TeamsOperationOutcome, TeamsOperationPayload, TeamsOperationTransport } from './operationOutbox.js';
import { TEAMS_API_VERSION, type TeamTask } from './types.js';
import { workspaceBindingSchema, workspaceGroupSchema, workspaceInteractionSchema, workspaceScopeSchema, type WorkspaceClientScope, type WorkspaceInteraction } from './workspaceContracts.js';

const id = z.string().min(1).max(256);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const cloudDirectorySchema = z.strictObject({
  apiVersion: z.literal(TEAMS_API_VERSION), scope: workspaceScopeSchema.omit({ groupId: true }),
  items: z.array(workspaceGroupSchema.extend({ memberCount: count, pendingCount: count, unreadCount: count, lastMessage: z.string().default('') })).max(100), nextCursor: z.string().min(1).max(4096).nullable(),
}).refine(value => new Set(value.items.map(item => item.groupId)).size === value.items.length, 'Duplicate group identity');
export type CloudDirectory = z.infer<typeof cloudDirectorySchema>;
export const cloudDirectoryBindingSchema = workspaceBindingSchema.extend({ name: z.string().min(1).max(256), revision: count.min(1), authorityRef: id });
export const cloudBindingDirectorySchema = z.strictObject({
  apiVersion: z.literal(TEAMS_API_VERSION), scope: workspaceScopeSchema.omit({ groupId: true }),
  items: z.array(cloudDirectoryBindingSchema).max(100), nextCursor: z.string().min(1).max(4096).nullable(),
}).refine(value => new Set(value.items.map(item => item.bindingRef)).size === value.items.length, 'Duplicate binding identity');
export type CloudBindingDirectory = z.infer<typeof cloudBindingDirectorySchema>;
export const cloudInteractionDetailSchema = workspaceInteractionSchema.extend({ message: z.string(), requestSchema: z.record(z.string(), z.unknown()).nullable() });
export type CloudInteractionDetail = z.infer<typeof cloudInteractionDetailSchema>;
const receiptSchema = z.strictObject({ status: z.enum(['accepted', 'duplicate', 'rejected', 'uncertain']), groupId: id.optional(), teamRunId: id.optional(), messageId: id.optional(), watermark: count.optional(), reason: z.string().max(2000).optional(), effectKey: id.optional(), phase: z.literal('resolved').optional(), revision: count.min(1).optional(), resolutionId: id.optional(), decision: z.enum(['confirmed_applied', 'confirmed_not_applied', 'accept_risk']).optional(), evidenceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional() });
const outcomeSchema = z.strictObject({ status: z.enum(['confirmed', 'rejected', 'pending', 'uncertain']), operationId: id, payloadDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/), receipt: receiptSchema.nullable(), code: z.string().max(100).optional() });
const missingSchema = z.strictObject({ status: z.literal('missing') });
const encode = encodeURIComponent;

/** Fixed-origin authenticated adapter; reads remain separate from durable mutations. */
export class HttpCloudTeamsProductClient implements TeamsOperationTransport, CloudMaterialPort {
  readonly origin: string;
  private readonly fetcher: TeamsFetch;
  private readonly groupsBase: string;
  private readonly teamsBase: string;
  constructor(options: { origin: string; fetch?: TeamsFetch; groupsBase?: string; teamsBase?: string }) {
    this.origin = new URL(options.origin).origin;
    if (options.origin !== this.origin || !/^https?:/.test(this.origin)) throw new TeamsError('invalid_workspace_origin', '团队服务来源无效。');
    const base = (value: string) => { const url = new URL(value, this.origin); if (url.origin !== this.origin || url.search || url.hash || url.username || url.password) throw new TeamsError('invalid_workspace_origin', '团队接口必须使用同一服务来源。'); return url.href.replace(/\/+$/, ''); };
    this.groupsBase = base(options.groupsBase ?? '/api/v1/groups'); this.teamsBase = base(options.teamsBase ?? '/api/v1/teams');
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  private async json(url: string, signal: AbortSignal, scope: Pick<WorkspaceClientScope, 'authorityId' | 'ownerScopeRef'>, payload?: unknown, binary?: Blob) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const response = await this.fetcher(url, { method: binary ? 'PUT' : payload === undefined ? 'GET' : 'POST', signal, credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers: { ...cloudScopeHeaders(scope), Accept: 'application/json', ...(binary ? { 'Content-Type': 'application/octet-stream' } : payload === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(binary ? { body: binary } : payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    // Limit the whole body, including error replies, before schema validation.
    if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) { await response.body?.cancel(); throw new TeamsError('cloud_contract_mismatch', '团队响应超过大小限制。'); }
    const reader = response.body?.getReader(); if (!reader) throw new TeamsError('cloud_contract_mismatch', '团队服务未返回数据。');
    let bytes = 0; const chunks: Uint8Array[] = [];
    const cancel = () => { void reader.cancel(); }; signal.addEventListener('abort', cancel, { once: true });
    try { while (true) { const part = await reader.read(); if (signal.aborted) throw new DOMException('Aborted', 'AbortError'); if (part.done) break; bytes += part.value.byteLength; if (bytes > 2 * 1024 * 1024) throw new TeamsError('cloud_contract_mismatch', '团队响应超过大小限制。'); chunks.push(part.value); } }
    finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const all = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
    let body: unknown; try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all)); canonicalTeamsJson(body); } catch { throw new TeamsError('cloud_contract_mismatch', '团队响应格式无效。'); }
    if (!response.ok) { const error = body as { error?: { code?: unknown } }; const code = error.error?.code; throw new TeamsError(typeof code === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(code) ? code : 'cloud_http_error', `团队请求失败（${response.status}）。`, response.status); }
    return body;
  }
  async list(scope: Omit<WorkspaceClientScope, 'groupId'>, signal: AbortSignal, cursor?: string): Promise<CloudDirectory> {
    if (scope.origin !== this.origin) throw new TeamsError('scope_mismatch', '团队来源不一致。');
    const query = new URLSearchParams({ limit: '50' }); if (cursor) query.set('cursor', cursor);
    const value = cloudDirectorySchema.parse(await this.json(`${this.groupsBase}?${query}`, signal, scope));
    if (value.scope.authorityId !== scope.authorityId || value.scope.ownerScopeRef !== scope.ownerScopeRef || value.items.some(item => item.authorityRef !== scope.authorityId)) throw new TeamsError('scope_mismatch', '团队目录属于其他身份。');
    if (cursor && value.nextCursor === cursor) throw new TeamsError('cloud_contract_mismatch', '团队目录游标未前进。');
    return value;
  }
  async bindings(scope: Omit<WorkspaceClientScope, 'groupId'>, signal: AbortSignal, cursor?: string): Promise<CloudBindingDirectory> {
    if (scope.origin !== this.origin) throw new TeamsError('scope_mismatch', '成员目录来源不一致。');
    const query = new URLSearchParams({ limit: '100' }); if (cursor) query.set('cursor', cursor);
    const value = cloudBindingDirectorySchema.parse(await this.json(`${this.groupsBase}/bindings?${query}`, signal, scope));
    if (value.scope.authorityId !== scope.authorityId || value.scope.ownerScopeRef !== scope.ownerScopeRef || value.items.some(item => item.authorityRef !== scope.authorityId)) throw new TeamsError('scope_mismatch', '成员目录属于其他身份。');
    if (cursor && value.nextCursor === cursor) throw new TeamsError('cloud_contract_mismatch', '成员目录游标未前进。');
    return value;
  }
  private target(operation: Readonly<TeamsOperation>) {
    if (operation.scope.origin !== this.origin) throw new TeamsError('scope_mismatch', '操作来源不一致。');
    const group = operation.scope.groupId;
    if (!group && operation.operation === 'groups') return { path: this.groupsBase, targetId: '' };
    const prefix = `groups/${group}/`; const suffix = operation.operation.slice(prefix.length);
    // Explicit allowlist: persisted data can never choose arbitrary endpoints or verbs.
    if (!group || !operation.operation.startsWith(prefix) || !/^(messages|interactions|team-runs\/[^/]+\/(control|acceptance)|tasks\/[^/]+\/actions|effects\/[^/]+\/reconcile)$/.test(suffix)) throw new TeamsError('invalid_cloud_operation', '不支持的团队操作。');
    const parts = suffix.split('/');
    return { path: `${this.groupsBase}/${encode(group)}/${parts.map(encode).join('/')}`, targetId: group };
  }
  private outcome(raw: unknown, operation: Readonly<TeamsOperation>): TeamsOperationOutcome {
    const result = outcomeSchema.parse(raw);
    if (result.payloadDigest !== operation.payloadDigest || (result.receipt?.groupId && operation.scope.groupId && result.receipt.groupId !== operation.scope.groupId)) throw new TeamsError('scope_mismatch', '操作回执与原始意图不一致。');
    if (result.status === 'confirmed' && (!result.receipt || !['accepted', 'duplicate'].includes(result.receipt.status))) throw new TeamsError('cloud_contract_mismatch', '操作尚未被事务接受。');
    const runTarget = /^groups\/[^/]+\/team-runs\/([^/]+)\//.exec(operation.operation)?.[1];
    const expectedRun = typeof operation.payload.teamRunId === 'string' ? operation.payload.teamRunId : runTarget;
    if (result.receipt?.teamRunId && expectedRun && result.receipt.teamRunId !== expectedRun) throw new TeamsError('scope_mismatch', '操作回执属于其他协作任务。');
    if (result.status === 'confirmed' && (!result.receipt?.groupId || (operation.payload.intent === 'start_goal' && !result.receipt.teamRunId))) throw new TeamsError('cloud_contract_mismatch', '原单缺少已创建的资源标识。');
    const effectTarget = /^groups\/[^/]+\/effects\/([^/]+)\/reconcile$/.exec(operation.operation)?.[1];
    if (result.status === 'confirmed' && effectTarget && (result.receipt?.effectKey !== effectTarget || result.receipt?.phase !== 'resolved' || !result.receipt.resolutionId || !result.receipt.revision || !result.receipt.evidenceDigest || result.receipt.decision !== operation.payload.decision)) throw new TeamsError('scope_mismatch', '核查回执与原操作不一致。');
    if (result.status === 'pending' || result.status === 'uncertain') return { status: result.status, serverOperationId: result.operationId };
    const receipt = result.receipt as TeamsOperationPayload | null;
    return result.status === 'confirmed' ? { status: 'confirmed', serverOperationId: result.operationId, ...(receipt ? { receipt } : {}) } : { status: 'rejected', code: result.code ?? 'operation_rejected', serverOperationId: result.operationId, ...(receipt ? { receipt } : {}) };
  }
  async lookup(operation: Readonly<TeamsOperation>, signal: AbortSignal): Promise<TeamsOperationOutcome | { status: 'missing' }> {
    const { targetId } = this.target(operation);
    const raw = await this.json(`${this.teamsBase}/operations/lookup`, signal, operation.scope, { idempotencyKey: operation.idempotencyKey, operation: operation.operation, targetId });
    if (missingSchema.safeParse(raw).success) return { status: 'missing' };
    return this.outcome(raw, operation);
  }
  async send(operation: Readonly<TeamsOperation>, signal: AbortSignal): Promise<TeamsOperationOutcome> {
    const { path } = this.target(operation);
    return this.outcome(await this.json(path, signal, operation.scope, { ...operation.payload, idempotencyKey: operation.idempotencyKey }), operation);
  }
  async interaction(scope: WorkspaceClientScope, summary: WorkspaceInteraction, signal: AbortSignal): Promise<CloudInteractionDetail> {
    if (scope.origin !== this.origin || summary.groupId !== scope.groupId) throw new TeamsError('scope_mismatch', '审批不属于当前团队。');
    const query = new URLSearchParams({ teamRunId: summary.teamRunId, ...summary.ref });
    const raw = await this.json(`${this.groupsBase}/${encode(scope.groupId)}/interactions/${encode(summary.ref.interactionId)}?${query}`, signal, scope);
    const value = cloudInteractionDetailSchema.parse(raw);
    if (canonicalTeamsJson(value.ref) !== canonicalTeamsJson(summary.ref) || value.teamRunId !== summary.teamRunId || value.groupId !== scope.groupId || value.revision !== summary.revision) throw new TeamsError('stale_interaction', '审批已更新，请刷新后查看。');
    return value;
  }
  async task(scope: WorkspaceClientScope, taskId: string, teamRunId: string, signal: AbortSignal): Promise<TeamTask> {
    if (scope.origin !== this.origin) throw new TeamsError('scope_mismatch', '任务来源不一致。');
    const value = taskSchema.parse(await this.json(`${this.groupsBase}/${encode(scope.groupId)}/tasks/${encode(taskId)}?teamRunId=${encode(teamRunId)}`, signal, scope)) as TeamTask;
    if (value.taskId !== taskId || value.groupId !== scope.groupId || value.teamRunId !== teamRunId) throw new TeamsError('scope_mismatch', '任务详情不属于当前协作。');
    return value;
  }
  async effects(scope: WorkspaceClientScope, teamRunId: string, signal: AbortSignal, after = 0): Promise<CloudEffectPage> {
    if (scope.origin !== this.origin || !teamRunId || !Number.isSafeInteger(after) || after < 0) throw new TeamsError('scope_mismatch', '执行核查不属于当前工作区。');
    const query = new URLSearchParams({ after: String(after), limit: '50' });
    const value = cloudEffectPageSchema.parse(await this.json(`${this.groupsBase}/${encode(scope.groupId)}/team-runs/${encode(teamRunId)}/effects?${query}`, signal, scope));
    if (value.scope.authorityId !== scope.authorityId || value.scope.ownerScopeRef !== scope.ownerScopeRef || value.scope.groupId !== scope.groupId || value.teamRunId !== teamRunId || value.items.some(row => row.groupId !== scope.groupId || row.teamRunId !== teamRunId || (row.resolution && row.resolution.ownerScopeRef !== scope.ownerScopeRef))) throw new TeamsError('scope_mismatch', '执行核查记录属于其他任务或身份。');
    if (value.nextCursor !== null && value.nextCursor <= after) throw new TeamsError('cloud_contract_mismatch', '执行核查游标未前进。');
    return value;
  }
  async createMaterial(scope: CloudMaterialScope, input: TeamsMaterialCreateInput, signal: AbortSignal): Promise<CloudMaterial> {
    if (scope.origin !== this.origin) throw new TeamsError('scope_mismatch', '材料来源不一致。');
    const payload = teamsMaterialCreateSchema.parse(input);
    return verifyCloudMaterial(await this.json(`${this.teamsBase}/materials`, signal, scope, payload), scope, { kind: payload.kind, entries: payload.entries, ...(payload.sourceCommit ? { sourceCommit: payload.sourceCommit } : {}) });
  }
  async uploadMaterialBlob(scope: CloudMaterialScope, raw: CloudMaterial, entry: CloudMaterialEntry, file: Blob, signal: AbortSignal): Promise<void> {
    if (scope.origin !== this.origin) throw new TeamsError('scope_mismatch', '材料来源不一致。');
    const material = await verifyCloudMaterial(raw, scope);
    if (file.size !== entry.sizeBytes || !material.manifest.entries.some(item => canonicalTeamsJson(item) === canonicalTeamsJson(entry))) throw new TeamsError('material_identity_conflict', '文件与原材料清单不一致。');
    const result = cloudMaterialBlobSchema.parse(await this.json(`${this.teamsBase}/materials/${encode(material.materialId)}/blobs/${encode(entry.digest)}`, signal, scope, undefined, file));
    if (result.digest !== entry.digest || result.sizeBytes !== entry.sizeBytes) throw new TeamsError('material_identity_conflict', '上传回执与原文件不一致。');
  }
  async finalizeMaterial(scope: CloudMaterialScope, raw: CloudMaterial, idempotencyKey: string, signal: AbortSignal): Promise<CloudMaterial> {
    if (scope.origin !== this.origin) throw new TeamsError('scope_mismatch', '材料来源不一致。');
    const material = await verifyCloudMaterial(raw, scope);
    const response = await this.json(`${this.teamsBase}/materials/${encode(material.materialId)}/finalize`, signal, scope, { manifestDigest: material.manifestDigest, idempotencyKey });
    const pending = cloudMaterialMissingSchema.safeParse(response);
    if (pending.success) {
      const missing = pending.data.missingBlobs;
      if (pending.data.materialId !== material.materialId || !missing.length || new Set(missing).size !== missing.length || missing.some(fingerprint => !material.manifest.entries.some(entry => entry.digest === fingerprint))) throw new TeamsError('material_identity_conflict', '待上传文件与原材料清单不一致。');
      // Valid pending responses are a recoverable upload state, not a malformed filename.
      throw new Error('服务端尚未确认所有文件，请重试原上传。');
    }
    return verifyCloudMaterial(response, scope, material.manifest);
  }
  artifactUrl(scope: WorkspaceClientScope, artifactId: string, teamRunId: string) {
    if (scope.origin !== this.origin || !teamRunId) throw new TeamsError('scope_mismatch', '交付物来源不一致。');
    cloudScopeHeaders(scope);
    const query = new URLSearchParams({ expectAuthorityId: scope.authorityId, expectOwnerScopeRef: scope.ownerScopeRef, teamRunId });
    return `${this.groupsBase}/${encode(scope.groupId)}/artifacts/${encode(artifactId)}/content?${query}`;
  }
}
