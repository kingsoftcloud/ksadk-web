import { TeamsError } from './contracts.js';
import type { CloudWorkspaceTransport } from './cloudClient.js';
import type { ConnectionStatus } from './types.js';
import { workspaceClientScopeKey, workspaceClientScopeSchema, workspaceScopeKey, type WorkspaceClientScope, type WorkspaceCollection } from './workspaceContracts.js';
import { WorkspaceReducer, type WorkspaceProjection } from './workspaceReducer.js';

export interface WorkspaceObservation {
  scope: Readonly<WorkspaceClientScope>;
  selectedRunId: string | null;
  projection: WorkspaceProjection | null;
  connection: ConnectionStatus;
  draft: string;
  errorCode: string | null;
  loadingPages: WorkspaceCollection[];
}
const resyncCodes = new Set(['reset_required', 'snapshot_expired', 'workspace_page_mismatch', 'workspace_contract_mismatch']);
const wait = (delay: number, signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) { resolve(); return; }
  const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
  const timer = setTimeout(finish, delay);
  signal.addEventListener('abort', finish, { once: true });
});

/** Requests, reducers, pages and drafts are owned by one immutable authenticated scope. */
export class WorkspaceObserver {
  readonly scope: Readonly<WorkspaceClientScope>;
  readonly cacheKey: string;
  private readonly transport: CloudWorkspaceTransport;
  private readonly maxReconnects: number;
  private readonly retryDelay: (attempt: number) => number;
  private value: WorkspaceObservation;
  private reducer?: WorkspaceReducer;
  private listeners = new Set<() => void>();
  private drafts = new Map<string, string>();
  private pendingPages = new Map<WorkspaceCollection, Promise<boolean>>();
  private controller?: AbortController;
  private streamController?: AbortController;
  private generation = 0;
  private disposed = false;
  private resyncRequested = false;
  private observingGeneration?: number;

  constructor(scope: WorkspaceClientScope, transport: CloudWorkspaceTransport, options: { maxReconnects?: number; retryDelayMs?: (attempt: number) => number } = {}) {
    this.scope = Object.freeze(workspaceClientScopeSchema.parse(scope)); this.cacheKey = workspaceClientScopeKey(this.scope); this.transport = transport;
    this.maxReconnects = options.maxReconnects ?? 6;
    if (!Number.isSafeInteger(this.maxReconnects) || this.maxReconnects < 0 || this.maxReconnects > 32) throw new TeamsError('invalid_reconnect_limit', '重连次数必须在 0–32 之间。');
    this.retryDelay = options.retryDelayMs ?? (attempt => Math.min(500 * 2 ** attempt, 10_000));
    this.value = { scope: this.scope, selectedRunId: null, projection: null, connection: 'closed', draft: '', errorCode: null, loadingPages: [] };
  }
  getSnapshot = (): WorkspaceObservation => this.value;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<WorkspaceObservation>) {
    if (this.disposed) return;
    this.value = { ...this.value, ...patch };
    this.listeners.forEach(listener => listener());
  }
  setDraft(draft: string) {
    this.drafts.set(this.value.selectedRunId ?? '', draft);
    this.update({ draft });
  }
  /** A recovered ACK clears only its original, unchanged draft, even after a run switch. */
  acknowledgeDraft(teamRunId: string | null, submittedText: string): boolean {
    if (this.disposed) return false;
    const key = teamRunId ?? '';
    const draft = this.value.selectedRunId === teamRunId ? this.value.draft : this.drafts.get(key);
    if (draft === undefined || draft.trim() !== submittedText) return false;
    this.drafts.set(key, '');
    if (this.value.selectedRunId === teamRunId) this.update({ draft: '' });
    return true;
  }
  /** Ends only observation; never dispatches, stops or cancels an Agent execution. */
  disconnect() {
    this.generation++; this.controller?.abort(); this.streamController?.abort(); this.controller = undefined;
    this.observingGeneration = undefined; this.pendingPages.clear(); this.update({ connection: 'closed', loadingPages: [] });
  }
  dispose() {
    this.disconnect(); this.reducer = undefined; this.drafts.clear();
    this.update({ projection: null, draft: '', selectedRunId: null, errorCode: null });
    this.disposed = true; this.listeners.clear();
  }
  refresh() {
    if (this.disposed) return;
    if (this.observingGeneration === undefined) { void this.observe(this.value.selectedRunId ?? undefined); return; }
    this.resyncRequested = true; this.update({ connection: 'reconnecting' }); this.streamController?.abort();
  }

  async observe(teamRunId?: string): Promise<void> {
    if (this.disposed) throw new TeamsError('scope_disposed', '工作区观察已关闭。');
    const previousRun = this.value.selectedRunId;
    this.disconnect();
    const generation = ++this.generation;
    this.observingGeneration = generation;
    const controller = new AbortController(); this.controller = controller;
    const current = () => !this.disposed && generation === this.generation && !controller.signal.aborted;
    if (teamRunId !== previousRun) this.reducer = undefined;
    this.resyncRequested = false;
    this.update({ selectedRunId: teamRunId ?? null, projection: this.reducer?.projection() ?? null, draft: this.drafts.get(teamRunId ?? '') ?? '', connection: 'connecting', errorCode: null });
    let resolvedRun = teamRunId;
    let needsSnapshot = true; let failures = 0;
    try {
      while (current()) {
        try {
          if (needsSnapshot) {
            this.resyncRequested = false; this.pendingPages.clear(); this.update({ loadingPages: [] });
            const snapshot = await this.transport.read(this.scope, { teamRunId: resolvedRun, signal: controller.signal });
            if (!current()) return;
            if (workspaceScopeKey(snapshot.scope) !== workspaceScopeKey(this.scope) || (resolvedRun !== undefined && snapshot.selectedRun?.teamRunId !== resolvedRun)) throw new TeamsError('scope_mismatch', '工作区快照与当前身份或所选任务不一致。');
            if (this.reducer) {
              if (!this.reducer.replace(snapshot)) throw new TeamsError('reset_required', '工作区快照早于当前事件水位。');
            } else this.reducer = new WorkspaceReducer(snapshot);
            resolvedRun = snapshot.selectedRun?.teamRunId;
            const selectedRunId = resolvedRun ?? null;
            const draft = this.value.selectedRunId === selectedRunId ? this.value.draft : this.drafts.get(selectedRunId ?? '') ?? this.value.draft;
            this.drafts.set(selectedRunId ?? '', draft);
            this.update({ selectedRunId, projection: this.reducer.projection(), draft });
            needsSnapshot = false; this.resyncRequested = false;
          }
          const reducer = this.reducer!;
          const stream = new AbortController(); this.streamController = stream;
          const cancelStream = () => stream.abort();
          controller.signal.addEventListener('abort', cancelStream, { once: true });
          this.update({ connection: 'connected', errorCode: null });
          try {
            await this.transport.subscribe(this.scope, reducer.watermark(), stream.signal, event => {
              if (!current() || stream.signal.aborted || this.reducer !== reducer) return;
              if (reducer.apply(event)) {
                failures = 0; const projection = reducer.projection(); this.update({ projection });
                if (projection.dirtyCollections.length) this.refresh();
              }
            });
          } finally { controller.signal.removeEventListener('abort', cancelStream); stream.abort(); }
          if (!current()) return;
          if (this.resyncRequested) { needsSnapshot = true; continue; }
          throw new TeamsError('stream_ended', '工作区事件连接已断开。');
        } catch (error) {
          if (!current()) return;
          if (this.resyncRequested) { needsSnapshot = true; continue; }
          const cause = error instanceof TeamsError ? error : new TeamsError('network_error', '工作区暂时无法连接。');
          if (cause.code === 'scope_mismatch' || [401, 403, 404].includes(cause.status ?? 0)) throw cause;
          if (resyncCodes.has(cause.code)) needsSnapshot = true;
          if (failures++ >= this.maxReconnects) throw cause;
          this.update({ connection: 'reconnecting', errorCode: cause.code });
          const delay = this.retryDelay(failures - 1);
          if (!Number.isFinite(delay) || delay < 0 || delay > 60_000) throw new TeamsError('invalid_retry_delay', '工作区重试间隔无效。');
          await wait(delay, controller.signal);
        }
      }
    } catch (error) {
      if (!current()) return;
      const cause = error instanceof TeamsError ? error : new TeamsError('network_error', '工作区无法连接。');
      if (cause.code === 'scope_mismatch' || [401, 403, 404].includes(cause.status ?? 0)) {
        this.reducer = undefined; this.drafts.clear(); this.update({ projection: null, draft: '' });
      }
      this.update({ connection: 'offline', errorCode: cause.code });
    } finally {
      if (this.observingGeneration === generation) this.observingGeneration = undefined;
    }
  }

  loadMore(collection: WorkspaceCollection, limit?: number): Promise<boolean> {
    if (this.disposed) return Promise.reject(new TeamsError('scope_disposed', '工作区观察已关闭。'));
    const pending = this.pendingPages.get(collection); if (pending) return pending;
    const reducer = this.reducer; const controller = this.controller; const generation = this.generation;
    if (!reducer || !controller || controller.signal.aborted) return Promise.reject(new TeamsError('workspace_not_ready', '工作区尚未就绪。'));
    const request = reducer.pageRequest(collection, limit); if (!request) return Promise.resolve(false);
    const alive = () => !this.disposed && generation === this.generation && !controller.signal.aborted && reducer === this.reducer;
    const current = () => alive() && reducer.snapshotId() === request.snapshotId;
    // Self-reference in finally must not delete a newer page request after a snapshot refresh.
    let work!: Promise<boolean>;
    // eslint-disable-next-line prefer-const
    work = (async () => {
      this.update({ loadingPages: [...new Set([...this.value.loadingPages, collection])] });
      try {
        const page = await this.transport.page(this.scope, request, controller.signal);
        if (!current()) return false;
        reducer.mergePage(request, page); this.update({ projection: reducer.projection() }); return true;
      } catch (error) {
        if (!current()) return false;
        const cause = error instanceof TeamsError ? error : new TeamsError('network_error', '分页加载失败。');
        if (cause.code === 'scope_mismatch' || [401, 403, 404].includes(cause.status ?? 0)) {
          this.disconnect(); this.reducer = undefined; this.drafts.clear(); this.update({ projection: null, draft: '', connection: 'offline', errorCode: cause.code });
          throw cause;
        }
        this.update({ errorCode: cause.code });
        if (resyncCodes.has(cause.code)) this.refresh();
        throw cause;
      } finally {
        if (alive() && this.pendingPages.get(collection) === work) { this.pendingPages.delete(collection); this.update({ loadingPages: this.value.loadingPages.filter(value => value !== collection) }); }
      }
    })();
    this.pendingPages.set(collection, work);
    return work;
  }
}
