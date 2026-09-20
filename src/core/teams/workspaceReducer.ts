import { canonicalTeamsJson } from './cloudCanonical.js';
import { TeamsError } from './contracts.js';
import {
  decodeTeamWorkspaceSnapshot, decodeWorkspaceEvent, decodeWorkspacePage, WORKSPACE_COLLECTIONS,
  workspaceRowKey, workspaceScopeKey, type TeamWorkspaceSnapshot, type WorkspaceCollection,
  type WorkspaceInteraction, type WorkspaceMessage, type WorkspacePageRequest, type WorkspaceRow,
} from './workspaceContracts.js';

export interface WorkspaceProjection {
  snapshot: TeamWorkspaceSnapshot;
  /** The immutable pagination boundary; live snapshot.watermark can advance beyond this. */
  snapshotWatermark: number;
  dirtyCollections: WorkspaceCollection[];
  dirtyRunIds: string[];
}
type RowVersion = { revision: number; digest: string; domainDigest: string; observedSeq: number };
const reset = (message: string): never => { throw new TeamsError('reset_required', message); };

/** A partial cloud projection only. It never invokes or subclasses the full local GroupReducer. */
export class WorkspaceReducer {
  private value: TeamWorkspaceSnapshot;
  private baseWatermark: number;
  private versions = new Map<string, RowVersion>();
  private seenSeq = new Map<number, string>();
  private seenIds = new Map<string, number>();
  private dirty = new Set<WorkspaceCollection>();
  private dirtyRuns = new Set<string>();
  private usedCursors = new Map<WorkspaceCollection, Set<string>>();
  private readonly maxRows: number;

  constructor(raw: unknown, options: { maxRowsPerCollection?: number } = {}) {
    this.value = decodeTeamWorkspaceSnapshot(raw);
    this.baseWatermark = this.value.watermark;
    this.maxRows = options.maxRowsPerCollection ?? 5_000;
    if (!Number.isSafeInteger(this.maxRows) || this.maxRows < 100 || this.maxRows > 50_000) throw new TeamsError('invalid_workspace_limit', '工作区缓存上限无效。');
    this.seedVersions();
  }
  snapshot(): TeamWorkspaceSnapshot { return structuredClone(this.value); }
  watermark(): number { return this.value.watermark; }
  snapshotId(): string { return this.value.snapshotId; }
  projection(): WorkspaceProjection {
    return { snapshot: this.snapshot(), snapshotWatermark: this.baseWatermark, dirtyCollections: [...this.dirty], dirtyRunIds: [...this.dirtyRuns] };
  }
  private seedVersions() {
    this.versions.clear();
    const save = (key: string, row: { revision: number }) => this.versions.set(key, { revision: row.revision, digest: canonicalTeamsJson(row), domainDigest: this.domainDigest(key, row), observedSeq: this.baseWatermark });
    save('group', this.value.group);
    this.value.members.forEach(row => save(`members:${row.memberId}`, row));
    this.value.selectedRunMembers.forEach(row => save(`runMembers:${row.runMemberId}`, row));
    for (const collection of WORKSPACE_COLLECTIONS) for (const row of this.value[collection]) save(`${collection}:${workspaceRowKey(collection, row)}`, row);
    if (this.value.selectedRun) save(`runSummaries:${this.value.selectedRun.teamRunId}`, this.value.selectedRun);
  }
  private domainDigest(key: string, row: { revision: number }): string {
    if (!key.startsWith('runSummaries:')) return canonicalTeamsJson(row);
    const domain = { ...row } as Record<string, unknown>; delete domain.taskCount; delete domain.pendingCount; delete domain.leaderStandby;
    return canonicalTeamsJson(domain);
  }
  private accept(versions: Map<string, RowVersion>, key: string, row: { revision: number }, observedSeq: number): boolean {
    const previous = versions.get(key);
    if (previous && (previous.revision > row.revision || previous.observedSeq > observedSeq)) return false;
    const digest = canonicalTeamsJson(row);
    const domainDigest = this.domainDigest(key, row);
    if (previous?.revision === row.revision) {
      if (previous.digest === digest) return false;
      // Counters and standby status are derived at groupSeq, not a new run CAS revision.
      if (observedSeq <= previous.observedSeq || previous.domainDigest !== domainDigest) reset('同一对象版本出现不同内容，需要重新读取。');
    }
    versions.set(key, { revision: row.revision, digest, domainDigest, observedSeq });
    return true;
  }
  private upsert<T>(rows: T[], row: T, key: (value: T) => string): T[] {
    const index = rows.findIndex(value => key(value) === key(row));
    if (index < 0 && rows.length >= this.maxRows) reset('工作区缓存已达到上限，需要重新读取分页视图。');
    return index < 0 ? [...rows, row] : rows.map((value, position) => position === index ? row : value);
  }
  private mergeRow(next: TeamWorkspaceSnapshot, versions: Map<string, RowVersion>, collection: WorkspaceCollection, row: WorkspaceRow, observedSeq: number) {
    const key = workspaceRowKey(collection, row);
    if (!this.accept(versions, `${collection}:${key}`, row, observedSeq)) {
      // A selected historical run can initially be outside the first summary page.
      if (collection === 'runSummaries' && next.selectedRun?.teamRunId === key && !next.runSummaries.some(run => run.teamRunId === key)) next.runSummaries = this.upsert(next.runSummaries, next.selectedRun, run => run.teamRunId);
      return;
    }
    if (collection === 'pendingInteractions' && !['pending', 'resolving'].includes((row as WorkspaceInteraction).status)) {
      next.pendingInteractions = next.pendingInteractions.filter(value => workspaceRowKey(collection, value) !== key);
      return; // Retain the version tombstone so an old page cannot resurrect it.
    }
    const rows = this.upsert(next[collection] as WorkspaceRow[], row, value => workspaceRowKey(collection, value));
    if (collection === 'recentMessages') rows.sort((a, b) => (a as WorkspaceMessage).createdSeq - (b as WorkspaceMessage).createdSeq || workspaceRowKey(collection, a).localeCompare(workspaceRowKey(collection, b)));
    // All collection items were checked by the discriminated wire decoder.
    Object.assign(next, { [collection]: rows });
  }

  replace(raw: unknown): boolean {
    const snapshot = decodeTeamWorkspaceSnapshot(raw);
    if (workspaceScopeKey(snapshot.scope) !== workspaceScopeKey(this.value.scope) || snapshot.selectedRun?.teamRunId !== this.value.selectedRun?.teamRunId) {
      throw new TeamsError('scope_mismatch', '刷新快照改变了工作区身份或所选协作任务。');
    }
    if (snapshot.watermark < this.value.watermark || snapshot.group.revision < this.value.group.revision
      || (snapshot.selectedRun && this.value.selectedRun && snapshot.selectedRun.revision < this.value.selectedRun.revision)) return false;
    this.value = snapshot; this.baseWatermark = snapshot.watermark;
    this.seenSeq.clear(); this.seenIds.clear(); this.dirty.clear(); this.dirtyRuns.clear(); this.usedCursors.clear(); this.seedVersions();
    return true;
  }

  apply(raw: unknown): boolean {
    const event = decodeWorkspaceEvent(raw);
    if (workspaceScopeKey(event.scope) !== workspaceScopeKey(this.value.scope)) throw new TeamsError('scope_mismatch', '事件不属于当前授权工作区。');
    const knownId = this.seenSeq.get(event.groupSeq);
    if (knownId && knownId !== event.eventId) reset('同一事件水位出现不同事件身份。');
    const knownSeq = this.seenIds.get(event.eventId);
    if (knownSeq !== undefined && knownSeq !== event.groupSeq) reset('同一事件身份被用于不同水位。');
    if (event.groupSeq <= this.value.watermark) return false;
    if (event.groupSeq !== this.value.watermark + 1) reset('团队事件存在缺口，需要重新读取工作区。');
    const next = { ...this.value };
    const versions = new Map(this.versions);
    const dirty = new Set(this.dirty); const dirtyRuns = new Set(this.dirtyRuns);
    const refreshedRuns = new Set<string>();
    const selectedId = next.selectedRun?.teamRunId ?? null;
    for (const change of event.changes) {
      if (change.kind === 'invalidate') {
        if (change.teamRunId === selectedId || change.teamRunId === null) change.collections.forEach(collection => dirty.add(collection));
        else dirtyRuns.add(change.teamRunId);
        continue;
      }
      if (change.kind === 'group') {
        if (change.group.tenantId !== next.group.tenantId || change.group.ownerSubject !== next.group.ownerSubject) throw new TeamsError('scope_mismatch', '群事件改变了原始租户或主体。');
        if (this.accept(versions, 'group', change.group, event.groupSeq)) next.group = change.group;
      } else if (change.kind === 'member') {
        if (this.accept(versions, `members:${change.member.memberId}`, change.member, event.groupSeq)) next.members = this.upsert(next.members, change.member, row => row.memberId);
      } else if (change.kind === 'run_member') {
        if (change.runMember.teamRunId !== selectedId) { dirtyRuns.add(change.runMember.teamRunId); continue; }
        if (this.accept(versions, `runMembers:${change.runMember.runMemberId}`, change.runMember, event.groupSeq)) next.selectedRunMembers = this.upsert(next.selectedRunMembers, change.runMember, row => row.runMemberId);
      } else if (change.kind === 'run') {
        const run = change.run;
        if (this.accept(versions, `runSummaries:${run.teamRunId}`, run, event.groupSeq)) {
          next.runSummaries = this.upsert(next.runSummaries, run, row => row.teamRunId);
          if (run.teamRunId === selectedId) next.selectedRun = run;
        }
        refreshedRuns.add(run.teamRunId);
      } else {
        const [collection, row]: [WorkspaceCollection, WorkspaceRow] = change.kind === 'task' ? ['taskSummaries', change.task]
          : change.kind === 'interaction' ? ['pendingInteractions', change.interaction]
            : change.kind === 'message' ? ['recentMessages', change.message] : ['artifactSummaries', change.artifact];
        if (row.teamRunId !== selectedId) {
          if (row.teamRunId) dirtyRuns.add(row.teamRunId);
          continue;
        }
        this.mergeRow(next, versions, collection, row, event.groupSeq);
        if (collection === 'taskSummaries' || collection === 'pendingInteractions') {
          dirty.add('runSummaries'); if (row.teamRunId) dirtyRuns.add(row.teamRunId);
        }
      }
    }
    refreshedRuns.forEach(runId => dirtyRuns.delete(runId));
    // Changes are committed together only after every delta has passed validation.
    if (!next.members.some(row => row.memberId === next.group.leaderMemberId)
      || (next.selectedRun && (!next.selectedRunMembers.some(row => row.memberId === next.selectedRun!.leaderMemberId)
        || next.selectedRunMembers.some(row => row.groupRevision !== next.selectedRun!.groupRevision)))) reset('Leader 变更缺少匹配成员投影。');
    next.watermark = event.groupSeq;
    this.value = next; this.versions = versions; this.dirty = dirty; this.dirtyRuns = dirtyRuns;
    this.seenSeq.set(event.groupSeq, event.eventId); this.seenIds.set(event.eventId, event.groupSeq);
    if (this.seenSeq.size > 10_000) {
      const oldest = this.seenSeq.entries().next().value!;
      this.seenSeq.delete(oldest[0]); this.seenIds.delete(oldest[1]);
    }
    return true;
  }

  pageRequest(collection: WorkspaceCollection, limit?: number): WorkspacePageRequest | null {
    const cursor = this.value.cursors[collection];
    if (cursor === null) return null;
    const teamRunId = collection === 'runSummaries' ? null : this.value.selectedRun?.teamRunId ?? null;
    if (collection !== 'runSummaries' && teamRunId === null) throw new TeamsError('scope_mismatch', '未选择任务，无法读取任务分页。');
    return { collection, snapshotId: this.value.snapshotId, watermark: this.baseWatermark, teamRunId, cursor, ...(limit === undefined ? {} : { limit }) };
  }
  mergePage(request: WorkspacePageRequest, raw: unknown): boolean {
    const page = decodeWorkspacePage(raw);
    if (workspaceScopeKey(page.scope) !== workspaceScopeKey(this.value.scope)) throw new TeamsError('scope_mismatch', '分页返回了其他授权工作区。');
    const current = this.pageRequest(request.collection, request.limit);
    if (!current || request.snapshotId !== current.snapshotId || request.watermark !== current.watermark || request.cursor !== current.cursor || request.teamRunId !== current.teamRunId
      || page.snapshotId !== current.snapshotId || page.watermark !== current.watermark || page.cursor !== current.cursor || page.teamRunId !== current.teamRunId || page.collection !== current.collection) {
      throw new TeamsError('workspace_page_mismatch', '分页与当前快照或任务不一致，需要重新读取。');
    }
    if (page.nextCursor !== null && this.usedCursors.get(page.collection)?.has(page.nextCursor)) throw new TeamsError('workspace_page_mismatch', '分页游标出现循环，需要重新读取。');
    const next = { ...this.value, cursors: { ...this.value.cursors } }; const versions = new Map(this.versions);
    for (const row of page.items) this.mergeRow(next, versions, page.collection, row, page.watermark);
    next.cursors[page.collection] = page.nextCursor;
    this.value = next; this.versions = versions;
    const cursors = this.usedCursors.get(page.collection) ?? new Set<string>(); cursors.add(page.cursor); this.usedCursors.set(page.collection, cursors);
    return true;
  }
}
