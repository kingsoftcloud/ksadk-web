import { cloudScopeHeaders } from './cloudScope.js';
import { consumeTeamsSse, type TeamsFetch } from './client.js';
import { TeamsError } from './contracts.js';
import {
  decodeTeamWorkspaceSnapshot, decodeWorkspaceEvent, decodeWorkspacePage, TEAMS_WORKSPACE_VERSION,
  workspacePageRequestSchema, workspaceScopeKey, type TeamWorkspaceSnapshot, type WorkspaceClientScope, type WorkspaceEvent,
  type WorkspacePage, type WorkspacePageRequest,
} from './workspaceContracts.js';

export interface CloudWorkspaceTransport {
  read(scope: WorkspaceClientScope, options: { teamRunId?: string; signal: AbortSignal }): Promise<TeamWorkspaceSnapshot>;
  page(scope: WorkspaceClientScope, request: WorkspacePageRequest, signal: AbortSignal): Promise<WorkspacePage>;
  subscribe(scope: WorkspaceClientScope, after: number, signal: AbortSignal, onEvent: (event: WorkspaceEvent) => void): Promise<void>;
}
function aborted(signal: AbortSignal) { if (signal.aborted) throw new DOMException('Aborted', 'AbortError'); }
async function boundedJson(response: Response, signal: AbortSignal, maxBytes: number): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) { await response.body?.cancel().catch(() => undefined); throw new TeamsError('workspace_response_too_large', '工作区响应超过大小限制。'); }
  if (!response.body) throw new TeamsError('workspace_contract_mismatch', '工作区服务未返回数据。');
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true }); let content = ''; let bytes = 0;
  try {
    while (true) {
      aborted(signal);
      const next = await reader.read();
      aborted(signal);
      if (next.done) { content += decoder.decode(); break; }
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new TeamsError('workspace_response_too_large', '工作区响应超过大小限制。');
      content += decoder.decode(next.value, { stream: true });
    }
    try { return JSON.parse(content); } catch { throw new TeamsError('workspace_contract_mismatch', '工作区响应不是有效 JSON。'); }
  } finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Read-only cloud projection adapter. User commands belong to the durable operation outbox. */
export class HttpCloudWorkspaceClient implements CloudWorkspaceTransport {
  readonly origin: string;
  private readonly base: string;
  private readonly fetcher: TeamsFetch;
  constructor(options: { origin: string; baseUrl?: string; fetch?: TeamsFetch }) {
    const origin = new URL(options.origin);
    const base = new URL(options.baseUrl ?? '/api/v1/groups', origin);
    if (!['https:', 'http:'].includes(origin.protocol) || origin.origin !== options.origin || base.origin !== origin.origin || base.search || base.hash || base.username || base.password) {
      throw new TeamsError('invalid_workspace_origin', '工作区客户端必须固定到同一服务来源。');
    }
    this.origin = origin.origin; this.base = base.href.replace(/\/+$/, '');
    this.fetcher = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  }
  private path(scope: WorkspaceClientScope, suffix: string): string {
    if (scope.origin !== this.origin) throw new TeamsError('scope_mismatch', '工作区来源与客户端不一致。');
    return `${this.base}/${encodeURIComponent(scope.groupId)}${suffix}`;
  }
  private async get(url: string, signal: AbortSignal, scope: WorkspaceClientScope): Promise<Response> {
    aborted(signal);
    const response = await this.fetcher(url, { method: 'GET', signal, credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers: { ...cloudScopeHeaders(scope), Accept: 'application/json, text/event-stream' } });
    aborted(signal);
    if (!response.ok) {
      const body = await boundedJson(response, signal, 64 * 1024).catch(() => ({})) as { code?: unknown; error?: { code?: unknown } };
      const rawCode = body.error?.code ?? body.code;
      const code = typeof rawCode === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(rawCode) ? rawCode : 'workspace_http_error';
      throw new TeamsError(code, `工作区请求失败（${response.status}）。`, response.status);
    }
    return response;
  }
  async read(scope: WorkspaceClientScope, options: { teamRunId?: string; signal: AbortSignal }): Promise<TeamWorkspaceSnapshot> {
    const query = new URLSearchParams({ viewVersion: TEAMS_WORKSPACE_VERSION });
    if (options.teamRunId !== undefined) query.set('teamRunId', options.teamRunId);
    const response = await this.get(this.path(scope, `/workspace?${query}`), options.signal, scope);
    const snapshot = decodeTeamWorkspaceSnapshot(await boundedJson(response, options.signal, 2 * 1024 * 1024));
    if (workspaceScopeKey(scope) !== workspaceScopeKey(snapshot.scope) || (options.teamRunId !== undefined && snapshot.selectedRun?.teamRunId !== options.teamRunId)) {
      throw new TeamsError('scope_mismatch', '服务返回了其他身份或任务的工作区。');
    }
    return snapshot;
  }
  async page(scope: WorkspaceClientScope, request: WorkspacePageRequest, signal: AbortSignal): Promise<WorkspacePage> {
    if (!workspacePageRequestSchema.safeParse(request).success) throw new TeamsError('invalid_workspace_page', '工作区分页参数无效。');
    if (request.collection !== 'runSummaries' && request.teamRunId === null) throw new TeamsError('scope_mismatch', '任务分页需要指定协作任务。');
    const suffix = request.collection === 'runSummaries' ? '/team-runs'
      : `/team-runs/${encodeURIComponent(request.teamRunId!)}/${({ taskSummaries: 'tasks', pendingInteractions: 'interactions', recentMessages: 'messages', artifactSummaries: 'artifacts' } as const)[request.collection]}`;
    const query = new URLSearchParams({ viewVersion: TEAMS_WORKSPACE_VERSION, snapshotId: request.snapshotId, watermark: String(request.watermark), cursor: request.cursor, limit: String(request.limit ?? 100) });
    const response = await this.get(this.path(scope, `${suffix}?${query}`), signal, scope);
    const page = decodeWorkspacePage(await boundedJson(response, signal, 2 * 1024 * 1024));
    if (workspaceScopeKey(scope) !== workspaceScopeKey(page.scope)) throw new TeamsError('scope_mismatch', '服务返回了其他身份的分页。');
    if (page.snapshotId !== request.snapshotId || page.watermark !== request.watermark || page.teamRunId !== request.teamRunId || page.collection !== request.collection || page.cursor !== request.cursor) {
      throw new TeamsError('workspace_page_mismatch', '服务分页与请求的只读快照不一致。');
    }
    return page;
  }
  async subscribe(scope: WorkspaceClientScope, after: number, signal: AbortSignal, onEvent: (event: WorkspaceEvent) => void): Promise<void> {
    if (!Number.isSafeInteger(after) || after < 0) throw new TeamsError('invalid_workspace_cursor', '工作区事件水位无效。');
    const query = new URLSearchParams({ after: String(after), viewVersion: TEAMS_WORKSPACE_VERSION });
    const response = await this.get(this.path(scope, `/events?${query}`), signal, scope);
    try { await consumeTeamsSse(response, signal, (type, raw) => {
      if (type === 'heartbeat' || type === 'ping') return;
      if (type === 'reset_required' || type === 'snapshot_expired') throw new TeamsError('reset_required', '工作区历史需要重新同步。');
      if (!['workspace.delta', 'workspace.event', 'message'].includes(type)) throw new TeamsError('workspace_contract_mismatch', '未知工作区事件，需要重新读取。');
      const event = decodeWorkspaceEvent(raw);
      if (workspaceScopeKey(scope) !== workspaceScopeKey(event.scope)) throw new TeamsError('scope_mismatch', '服务事件属于其他授权工作区。');
      onEvent(event);
    }); } catch (error) {
      if (error instanceof TeamsError && ['contract_mismatch', 'event_too_large'].includes(error.code)) throw new TeamsError('workspace_contract_mismatch', '工作区事件无法验证，需要重新读取。');
      throw error;
    }
  }
}
