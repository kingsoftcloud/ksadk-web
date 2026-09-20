import { describe, expect, it, vi } from 'vitest';
import { teamSnapshot, memberRef } from '../../e2e/fixtures/teams-data.js';
import {
  decodeTeamWorkspaceSnapshot, decodeWorkspaceEvent, HttpCloudWorkspaceClient, TeamsError,
  WorkspaceObserver, WorkspaceReducer, type CloudWorkspaceTransport, type TeamWorkspaceSnapshot,
  type WorkspaceChange, type WorkspaceClientScope, type WorkspaceEvent,
  type WorkspaceMessage, type WorkspacePage, type WorkspacePageRequest,
} from '../public/teams.js';

const clientScope: WorkspaceClientScope = { origin: 'https://studio.example', authorityId: 'fixture-local', ownerScopeRef: 'fixture-owner', groupId: 'fixture-group' };
const scope = { authorityId: clientScope.authorityId, ownerScopeRef: clientScope.ownerScopeRef, groupId: clientScope.groupId };
function snapshot(run = 'run-a', watermark = 10, snapshotId = `snapshot-${run}`): TeamWorkspaceSnapshot {
  const legacy = teamSnapshot();
  const members = legacy.members.map(member => ({ ...member, responsibility: member.responsibility ?? '', activeRunId: member.activeRunId ?? null, reason: null,
    binding: { ...member.binding, availability: { state: 'ready' as const, code: null, reason: null, action: null } } }));
  const selected = { ...legacy.teamRuns[0], teamRunId: run, goal: `Goal ${run}`, taskCount: 2, pendingCount: 1, reason: null } as Record<string, unknown>;
  delete selected.budget;
  return decodeTeamWorkspaceSnapshot({ apiVersion: 'teams.ksadk.io/v1', viewVersion: 'workspace/v1', scope,
    snapshotId, watermark, group: { ...legacy.group, policy: { taskAcceptance: 'leader', peerWake: false } }, members,
    runSummaries: [selected], selectedRun: selected, selectedRunMembers: members.map(member => ({ ...member, teamRunId: run, runMemberId: `run-member-${run}-${member.memberId}`, groupRevision: 1 })),
    taskSummaries: [{ taskId: 'task-a', groupId: scope.groupId, teamRunId: run, revision: 1, title: 'Current task', ownerMemberId: 'engineer', dependencies: ['not-loaded-task'], status: 'running', attemptCount: 1, reason: null }],
    pendingInteractions: [{ ref: { ...memberRef(), interactionId: 'question-a' }, groupId: scope.groupId, teamRunId: run, revision: 1, title: 'Please confirm', kind: 'approval', status: 'pending', createdAt: '2026-09-18T08:00:00.000Z' }],
    recentMessages: [message(run, 'message-8', 8)], artifactSummaries: [],
    cursors: { runSummaries: 'runs-next', taskSummaries: 'tasks-next', pendingInteractions: 'interactions-next', recentMessages: 'messages-before-8', artifactSummaries: null } });
}
function message(run: string, id: string, createdSeq: number): WorkspaceMessage {
  return { messageId: id, groupId: scope.groupId, teamRunId: run, revision: 1, createdSeq, createdAt: '2026-09-18T08:00:00.000Z', senderPrincipal: 'owner', senderName: 'Owner', groupRole: 'owner', memberId: null,
    parts: [{ kind: 'text', text: 'Same text' }], mentions: [], intent: 'followup', replyTo: null, sourceRefs: [], visibility: 'public' };
}
function event(seq: number, changes: WorkspaceChange[] = []): WorkspaceEvent {
  return { apiVersion: 'teams.ksadk.io/v1', viewVersion: 'workspace/v1', scope, eventId: `event-${seq}`, groupSeq: seq, type: 'workspace.delta', createdAt: '2026-09-18T08:00:00.000Z', changes };
}
function page(request: WorkspacePageRequest, items: unknown[], nextCursor: string | null = null): WorkspacePage {
  return { apiVersion: 'teams.ksadk.io/v1', viewVersion: 'workspace/v1', scope, collection: request.collection, snapshotId: request.snapshotId,
    watermark: request.watermark, teamRunId: request.teamRunId, cursor: request.cursor, items, nextCursor } as WorkspacePage;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function hold(signal: AbortSignal): Promise<void> { return new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); }); }
function transport(overrides: Partial<CloudWorkspaceTransport> = {}): CloudWorkspaceTransport {
  return { read: vi.fn(async (_scope, options) => snapshot(options.teamRunId)), page: vi.fn(async (_scope, request) => page(request, [])),
    subscribe: vi.fn(async (_scope, _after, signal) => hold(signal)), ...overrides };
}

describe('Strict partial workspace contracts', () => {
  it('accepts dependencies outside the loaded task page and keeps local full snapshots incompatible', () => {
    expect(snapshot().taskSummaries[0].dependencies).toEqual(['not-loaded-task']);
    expect(() => decodeTeamWorkspaceSnapshot(teamSnapshot())).toThrow();
    expect(() => decodeTeamWorkspaceSnapshot({ ...snapshot(), extraField: true })).toThrow();
    expect(() => decodeWorkspaceEvent({ ...event(11), type: 'future.workspace.event' })).toThrow();
  });

  it('rejects foreign identity/run rows, contradictory selected summaries and unsafe watermarks', () => {
    const value = snapshot();
    for (const patch of [
      { watermark: Number.MAX_SAFE_INTEGER + 1 },
      { group: { ...value.group, authorityRef: 'foreign' } },
      { selectedRun: { ...value.selectedRun!, revision: 2 } },
      { taskSummaries: [{ ...value.taskSummaries[0], teamRunId: 'run-b' }] },
      { pendingInteractions: [{ ...value.pendingInteractions[0], ref: { ...value.pendingInteractions[0].ref, authorityRef: 'foreign' } }] },
      { selectedRunMembers: value.selectedRunMembers.map(row => ({ ...row, groupRevision: 2 })) },
      { recentMessages: [message('run-a', 'newer', 11)] },
    ]) expect(() => decodeTeamWorkspaceSnapshot({ ...value, ...patch })).toThrow();
  });

  it('rejects unknown delta payload fields and complete responses above two MiB', () => {
    const value = snapshot();
    expect(() => decodeWorkspaceEvent(event(11, [{ kind: 'task', task: { ...value.taskSummaries[0], extra: true } } as unknown as WorkspaceChange]))).toThrow();
    expect(() => decodeTeamWorkspaceSnapshot({ ...value, recentMessages: [{ ...value.recentMessages[0], parts: [{ kind: 'text', text: '中'.repeat(700_000) }] }] })).toThrow();
  });
});

describe('WorkspaceReducer group sequence and partial pages', () => {
  it('advances the complete group sequence without mixing nonselected run objects into the view', () => {
    const value = snapshot(); const reducer = new WorkspaceReducer(value);
    const foreignTask = { ...value.taskSummaries[0], teamRunId: 'run-b', taskId: 'foreign-task', revision: 2 };
    expect(reducer.apply(event(11, [{ kind: 'task', task: foreignTask }]))).toBe(true);
    expect(reducer.snapshot().watermark).toBe(11);
    expect(reducer.snapshot().taskSummaries).toEqual(value.taskSummaries);
    expect(reducer.projection().dirtyRunIds).toEqual(['run-b']);
    const foreignRun = { ...value.selectedRun!, teamRunId: 'run-b', revision: 3, pendingCount: 2 };
    reducer.apply(event(12, [{ kind: 'run', run: foreignRun }]));
    expect(reducer.snapshot().selectedRun?.teamRunId).toBe('run-a');
    expect(reducer.snapshot().runSummaries.find(row => row.teamRunId === 'run-b')?.pendingCount).toBe(2);
    expect(reducer.projection().dirtyRunIds).toEqual([]);
    reducer.apply(event(13)); // No visible domain changes still consumes its groupSeq.
    expect(reducer.snapshot().watermark).toBe(13);
  });

  it('ignores exact replay and requires resync for gaps or reused event identities', () => {
    const reducer = new WorkspaceReducer(snapshot());
    expect(reducer.apply(event(11))).toBe(true);
    expect(reducer.apply(event(11))).toBe(false);
    expect(() => reducer.apply(event(13))).toThrow(/缺口/);
    expect(() => reducer.apply({ ...event(12), eventId: 'event-11' })).toThrow(/身份/);
    expect(() => reducer.apply({ ...event(11), eventId: 'different' })).toThrow(/身份/);
    expect(reducer.snapshot().watermark).toBe(11);
  });

  it('never partially applies a malformed delta batch or contradictory same revision', () => {
    const initial = snapshot(); const reducer = new WorkspaceReducer(initial);
    const valid: WorkspaceChange = { kind: 'task', task: { ...initial.taskSummaries[0], title: 'changed', revision: 2 } };
    const contradictory: WorkspaceChange = { kind: 'run', run: { ...initial.selectedRun!, goal: 'different same revision' } };
    expect(() => reducer.apply(event(11, [valid, contradictory]))).toThrow(/版本/);
    expect(reducer.snapshot()).toEqual(initial);
    expect(() => reducer.apply({ ...event(11), scope: { ...scope, ownerScopeRef: 'other-owner' } })).toThrow(/授权/);
  });

  it('merges pages at the frozen snapshot boundary without overwriting later live revisions', () => {
    const initial = snapshot(); const reducer = new WorkspaceReducer(initial);
    const request = reducer.pageRequest('taskSummaries')!;
    reducer.apply(event(11, [{ kind: 'task', task: { ...initial.taskSummaries[0], revision: 3, title: 'live update' } }]));
    reducer.mergePage(request, page(request, [initial.taskSummaries[0], { ...initial.taskSummaries[0], taskId: 'task-b' }]));
    expect(reducer.snapshot().taskSummaries).toHaveLength(2);
    expect(reducer.snapshot().taskSummaries.find(row => row.taskId === 'task-a')?.title).toBe('live update');
    expect(reducer.snapshot().watermark).toBe(11);
    expect(reducer.projection().snapshotWatermark).toBe(10);
    expect(reducer.pageRequest('taskSummaries')).toBeNull();
  });

  it('keeps resolved-interaction tombstones while an old pending page arrives', () => {
    const initial = snapshot(); const reducer = new WorkspaceReducer(initial);
    const request = reducer.pageRequest('pendingInteractions')!;
    reducer.apply(event(11, [{ kind: 'interaction', interaction: { ...initial.pendingInteractions[0], revision: 2, status: 'resolved' } }]));
    expect(reducer.snapshot().pendingInteractions).toEqual([]);
    reducer.mergePage(request, page(request, initial.pendingInteractions));
    expect(reducer.snapshot().pendingInteractions).toEqual([]);
  });

  it('merges message history by identity/revision rather than equal text', () => {
    const reducer = new WorkspaceReducer(snapshot());
    const request = reducer.pageRequest('recentMessages')!;
    reducer.apply(event(11, [{ kind: 'message', message: { ...message('run-a', 'message-8', 8), revision: 2, parts: [{ kind: 'text', text: 'edited' }] } }]));
    reducer.mergePage(request, page(request, [message('run-a', 'message-6', 6), message('run-a', 'message-7', 7), message('run-a', 'message-8', 8)]));
    expect(reducer.snapshot().recentMessages.map(row => row.messageId)).toEqual(['message-6', 'message-7', 'message-8']);
    expect(reducer.snapshot().recentMessages[2].parts).toEqual([{ kind: 'text', text: 'edited' }]);
  });

  it('rejects snapshot/cursor/run/watermark mismatch and pagination cycles', () => {
    const reducer = new WorkspaceReducer(snapshot()); const request = reducer.pageRequest('recentMessages')!;
    for (const patch of [{ snapshotId: 'new-snapshot' }, { watermark: 11 }, { teamRunId: 'run-b' }, { cursor: 'wrong-cursor' }]) {
      expect(() => reducer.mergePage(request, { ...page(request, []), ...patch })).toThrow();
    }
    expect(reducer.snapshot().cursors.recentMessages).toBe(request.cursor);
    reducer.mergePage(request, page(request, [], 'next-2'));
    const next = reducer.pageRequest('recentMessages')!;
    expect(() => reducer.mergePage(next, page(next, [], request.cursor))).toThrow(/循环/);
  });

  it('keeps the selected historical run when it later appears in a summary page', () => {
    const initial = snapshot(); initial.runSummaries = [];
    const reducer = new WorkspaceReducer(initial); const request = reducer.pageRequest('runSummaries')!;
    reducer.mergePage(request, page(request, [initial.selectedRun!]));
    expect(reducer.snapshot().runSummaries).toEqual([initial.selectedRun]);
  });

  it('updates derived counters at a newer event sequence without inventing a business revision', () => {
    const initial = snapshot(); const reducer = new WorkspaceReducer(initial); const request = reducer.pageRequest('runSummaries')!;
    reducer.apply(event(11, [{ kind: 'run', run: { ...initial.selectedRun!, taskCount: 3, pendingCount: 2 } }]));
    expect(reducer.snapshot().selectedRun).toMatchObject({ revision: 1, taskCount: 3, pendingCount: 2 });
    reducer.mergePage(request, page(request, [initial.selectedRun!]));
    expect(reducer.snapshot().runSummaries[0]).toMatchObject({ revision: 1, taskCount: 3, pendingCount: 2 });
  });

  it('refuses stale replacement and cross-run replacement but accepts a new consistent snapshot', () => {
    const reducer = new WorkspaceReducer(snapshot()); reducer.apply(event(11));
    expect(reducer.replace(snapshot())).toBe(false);
    expect(() => reducer.replace(snapshot('run-b', 12))).toThrow();
    expect(reducer.replace(snapshot('run-a', 12, 'fresh'))).toBe(true);
    expect(reducer.pageRequest('recentMessages')?.snapshotId).toBe('fresh');
    const external = reducer.snapshot(); external.taskSummaries[0].title = 'mutated';
    expect(reducer.snapshot().taskSummaries[0].title).not.toBe('mutated');
  });
});

describe('WorkspaceObserver recovery and scope lifecycle', () => {
  it('resynchronizes gaps and unknown events, retaining the draft and never issuing a user command', async () => {
    let reads = 0; let streams = 0;
    const client = transport({ read: vi.fn(async () => snapshot('run-a', reads++ === 0 ? 10 : reads === 2 ? 12 : 14, `snap-${reads}`)),
      subscribe: vi.fn(async (_scope, after, signal, onEvent) => {
        streams++;
        if (streams === 1) onEvent(event(12));
        else if (streams === 2) onEvent({ ...event(13), type: 'unknown.new.event' } as unknown as WorkspaceEvent);
        else { expect(after).toBe(14); await hold(signal); }
      }) });
    const observer = new WorkspaceObserver(clientScope, client, { retryDelayMs: () => 0 });
    const observing = observer.observe('run-a');
    observer.setDraft('keep my draft');
    await vi.waitFor(() => expect(streams).toBe(3));
    expect(observer.getSnapshot()).toMatchObject({ draft: 'keep my draft', connection: 'connected' });
    expect(observer.getSnapshot().projection?.snapshot.watermark).toBe(14);
    expect(Object.keys(client)).toEqual(['read', 'page', 'subscribe']);
    observer.dispose(); await observing;
  });

  it('reconnects from the last group watermark without an unnecessary snapshot', async () => {
    let streams = 0; const cursors: number[] = [];
    const client = transport({ subscribe: vi.fn(async (_scope, after, signal, onEvent) => {
      cursors.push(after); streams++;
      if (streams === 1) { onEvent(event(11)); throw new Error('offline'); }
      await hold(signal);
    }) });
    const observer = new WorkspaceObserver(clientScope, client, { retryDelayMs: () => 0 });
    const observing = observer.observe('run-a');
    await vi.waitFor(() => expect(streams).toBe(2));
    expect(cursors).toEqual([10, 11]); expect(client.read).toHaveBeenCalledOnce();
    observer.dispose(); await observing;
  });

  it('ignores an uncooperative old snapshot when the user selects another run', async () => {
    const oldRead = deferred<TeamWorkspaceSnapshot>();
    const client = transport({ read: vi.fn(async (_scope, options) => options.teamRunId === 'run-a' ? oldRead.promise : snapshot('run-b')) });
    const observer = new WorkspaceObserver(clientScope, client);
    const first = observer.observe('run-a'); observer.setDraft('draft a');
    const second = observer.observe('run-b'); observer.setDraft('draft b');
    await vi.waitFor(() => expect(observer.getSnapshot().projection?.snapshot.selectedRun?.teamRunId).toBe('run-b'));
    oldRead.resolve(snapshot('run-a')); await first;
    expect(observer.getSnapshot()).toMatchObject({ selectedRunId: 'run-b', draft: 'draft b' });
    observer.dispose(); await second;
  });

  it('ignores stale page and event callbacks after changing the selected run', async () => {
    const oldPage = deferred<WorkspacePage>(); let capturedRequest!: WorkspacePageRequest; let oldEvent!: (event: WorkspaceEvent) => void;
    const client = transport({ page: vi.fn(async (_scope, request) => { capturedRequest = request; return oldPage.promise; }),
      subscribe: vi.fn(async (_scope, _after, signal, onEvent) => { oldEvent ??= onEvent; await hold(signal); }) });
    const observer = new WorkspaceObserver(clientScope, client); const first = observer.observe('run-a');
    await vi.waitFor(() => expect(client.subscribe).toHaveBeenCalledTimes(1));
    const loading = observer.loadMore('recentMessages');
    const second = observer.observe('run-b');
    await vi.waitFor(() => expect(client.subscribe).toHaveBeenCalledTimes(2));
    oldPage.resolve(page(capturedRequest, [message('run-a', 'stale-old-message', 6)]));
    oldEvent(event(11, [{ kind: 'message', message: message('run-a', 'stale-event', 11) }]));
    expect(await loading).toBe(false);
    expect(observer.getSnapshot().projection?.snapshot.recentMessages.map(row => row.messageId)).toEqual(['message-8']);
    observer.dispose(); await Promise.all([first, second]);
  });

  it('keeps owner and origin caches/drafts isolated and scrubs state after disposal', async () => {
    const first = new WorkspaceObserver(clientScope, transport()); const running = first.observe('run-a');
    await vi.waitFor(() => expect(first.getSnapshot().projection).not.toBeNull()); first.setDraft('private');
    const second = new WorkspaceObserver({ ...clientScope, ownerScopeRef: 'other-owner' }, transport());
    const anotherOrigin = new WorkspaceObserver({ ...clientScope, origin: 'https://another.example' }, transport());
    expect(second.cacheKey).not.toBe(first.cacheKey); expect(anotherOrigin.cacheKey).not.toBe(first.cacheKey);
    expect(second.getSnapshot()).toMatchObject({ projection: null, draft: '' });
    first.dispose(); await running;
    expect(first.getSnapshot()).toMatchObject({ projection: null, draft: '', connection: 'closed' });
    second.dispose(); anotherOrigin.dispose();
  });

  it('resets expired pagination instead of interpreting 409 as an empty page', async () => {
    let reads = 0;
    const client = transport({ read: vi.fn(async () => snapshot('run-a', 10 + reads, `snapshot-${++reads}`)),
      page: vi.fn(async () => { throw new TeamsError('snapshot_expired', 'expired', 409); }) });
    const observer = new WorkspaceObserver(clientScope, client, { retryDelayMs: () => 0 }); const observing = observer.observe('run-a');
    await vi.waitFor(() => expect(client.subscribe).toHaveBeenCalledTimes(1)); observer.setDraft('persist');
    await expect(observer.loadMore('recentMessages')).rejects.toMatchObject({ code: 'snapshot_expired' });
    await vi.waitFor(() => expect(reads).toBe(2));
    expect(observer.getSnapshot().draft).toBe('persist');
    expect(observer.getSnapshot().projection?.snapshot.cursors.recentMessages).toBe('messages-before-8');
    observer.dispose(); await observing;
  });

  it('does not let a late old-snapshot page corrupt or re-reset a refreshed snapshot', async () => {
    let reads = 0; const oldPage = deferred<WorkspacePage>(); let request!: WorkspacePageRequest;
    const client = transport({ read: vi.fn(async () => snapshot('run-a', 10 + reads, `snapshot-${++reads}`)),
      page: vi.fn(async (_scope, input) => { request = input; return oldPage.promise; }) });
    const observer = new WorkspaceObserver(clientScope, client); const observing = observer.observe('run-a');
    await vi.waitFor(() => expect(client.subscribe).toHaveBeenCalledTimes(1));
    const loading = observer.loadMore('recentMessages'); observer.refresh();
    await vi.waitFor(() => expect(client.subscribe).toHaveBeenCalledTimes(2));
    oldPage.resolve(page(request, [message('run-a', 'old-page', 6)]));
    expect(await loading).toBe(false);
    expect(observer.getSnapshot().projection?.snapshot.snapshotId).toBe('snapshot-2');
    expect(reads).toBe(2); expect(observer.getSnapshot().loadingPages).toEqual([]);
    observer.dispose(); await observing;
  });

  it('bounds repeated resync failures and purges a revoked identity', async () => {
    const broken = transport({ subscribe: vi.fn(async () => { throw new TeamsError('reset_required', 'expired'); }) });
    const limited = new WorkspaceObserver(clientScope, broken, { maxReconnects: 1, retryDelayMs: () => 0 });
    await limited.observe('run-a');
    expect(broken.read).toHaveBeenCalledTimes(2); expect(limited.getSnapshot().connection).toBe('offline'); limited.dispose();
    const revoked = transport({ page: vi.fn(async () => { throw new TeamsError('forbidden', 'revoked', 403); }) });
    const observer = new WorkspaceObserver(clientScope, revoked); const observing = observer.observe('run-a');
    await vi.waitFor(() => expect(revoked.subscribe).toHaveBeenCalledOnce()); observer.setDraft('private');
    await expect(observer.loadMore('recentMessages')).rejects.toMatchObject({ status: 403 });
    await observing;
    expect(observer.getSnapshot()).toMatchObject({ projection: null, draft: '', connection: 'offline' }); observer.dispose();
  });

  it('automatically refreshes invalidated selected-run collections while preserving the draft', async () => {
    let reads = 0; let onEvent!: (value: WorkspaceEvent) => void;
    const client = transport({ read: vi.fn(async () => snapshot('run-a', 10 + reads, `snapshot-${++reads}`)),
      subscribe: vi.fn(async (_scope, _after, signal, apply) => { onEvent = apply; await hold(signal); }) });
    const observer = new WorkspaceObserver(clientScope, client); const work = observer.observe('run-a');
    await vi.waitFor(() => expect(client.subscribe).toHaveBeenCalledTimes(1)); observer.setDraft('preserve');
    onEvent(event(11, [{ kind: 'invalidate', teamRunId: 'run-a', collections: ['artifactSummaries'] }]));
    await vi.waitFor(() => expect(client.read).toHaveBeenCalledTimes(2));
    expect(observer.getSnapshot().projection?.dirtyCollections).toEqual([]); expect(observer.getSnapshot().draft).toBe('preserve');
    observer.dispose(); await work;
  });

  it('can explicitly refresh after the bounded observer has gone offline', async () => {
    const client = transport({ read: vi.fn(async () => { throw new Error('offline'); }) });
    const observer = new WorkspaceObserver(clientScope, client, { maxReconnects: 0 });
    await observer.observe('run-a'); expect(observer.getSnapshot().connection).toBe('offline');
    vi.mocked(client.read).mockResolvedValue(snapshot()); observer.refresh();
    await vi.waitFor(() => expect(observer.getSnapshot().connection).toBe('connected'));
    observer.dispose();
  });
});

describe('HTTP cloud workspace transport', () => {
  it('calls only readonly endpoints with explicit frozen page identity and full group event cursor', async () => {
    const requests: string[] = []; const value = snapshot(); const reducer = new WorkspaceReducer(value); const request = reducer.pageRequest('recentMessages')!;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method).toBe('GET'); expect(init?.headers).toMatchObject({ 'X-Teams-Authority-Id': scope.authorityId, 'X-Teams-Owner-Scope-Ref': scope.ownerScopeRef }); requests.push(url);
      if (url.includes('/events?')) return new Response(`event: workspace.event\ndata: ${JSON.stringify(event(11))}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      return Response.json(url.includes('/workspace?') ? value : page(request, [message('run-a', 'older', 6)]));
    });
    const client = new HttpCloudWorkspaceClient({ origin: clientScope.origin, fetch: fetcher }); const signal = new AbortController().signal;
    expect((await client.read(clientScope, { teamRunId: 'run-a', signal })).snapshotId).toBe(value.snapshotId);
    expect((await client.page(clientScope, request, signal)).items).toHaveLength(1);
    const events: WorkspaceEvent[] = []; await client.subscribe(clientScope, 10, signal, value => events.push(value));
    expect(events[0].groupSeq).toBe(11);
    expect(requests[0]).toContain('/api/v1/groups/fixture-group/workspace?viewVersion=workspace%2Fv1&teamRunId=run-a');
    expect(requests[1]).toContain('snapshotId=snapshot-run-a&watermark=10&cursor=messages-before-8');
    expect(requests[2]).toContain('events?after=10&viewVersion=workspace%2Fv1');
    expect(requests[2]).not.toContain('teamRunId');
  });

  it('rejects other-scope responses, mismatched page identities and HTTP errors', async () => {
    const signal = new AbortController().signal; const value = snapshot();
    const foreign = new HttpCloudWorkspaceClient({ origin: clientScope.origin, fetch: async () => Response.json({ ...value, scope: { ...scope, ownerScopeRef: 'foreign' } }) });
    await expect(foreign.read(clientScope, { signal })).rejects.toMatchObject({ code: 'scope_mismatch' });
    const request = new WorkspaceReducer(value).pageRequest('recentMessages')!;
    const mismatch = new HttpCloudWorkspaceClient({ origin: clientScope.origin, fetch: async () => Response.json({ ...page(request, []), watermark: 11 }) });
    await expect(mismatch.page(clientScope, request, signal)).rejects.toMatchObject({ code: 'workspace_page_mismatch' });
    const expired = new HttpCloudWorkspaceClient({ origin: clientScope.origin, fetch: async () => Response.json({ code: 'snapshot_expired' }, { status: 409 }) });
    await expect(expired.page(clientScope, request, signal)).rejects.toMatchObject({ code: 'snapshot_expired', status: 409 });
    expect(() => new HttpCloudWorkspaceClient({ origin: clientScope.origin, baseUrl: 'https://foreign.example/api' })).toThrow();
  });

  it('rejects unknown SSE frame names and translates malformed frames into resync errors', async () => {
    for (const raw of [`event: future.command\ndata: ${JSON.stringify(event(11))}\n\n`, 'data: broken-json\n\n']) {
      const client = new HttpCloudWorkspaceClient({ origin: clientScope.origin, fetch: async () => new Response(raw, { headers: { 'content-type': 'text/event-stream' } }) });
      await expect(client.subscribe(clientScope, 10, new AbortController().signal, () => undefined)).rejects.toMatchObject({ code: 'workspace_contract_mismatch' });
    }
  });

  it('rejects oversized streaming JSON and unknown workspace events', async () => {
    const signal = new AbortController().signal;
    const huge = new HttpCloudWorkspaceClient({ origin: clientScope.origin, fetch: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) });
    await expect(huge.read(clientScope, { signal })).rejects.toMatchObject({ code: 'workspace_response_too_large' });
    const unknown = new HttpCloudWorkspaceClient({ origin: clientScope.origin, fetch: async () => new Response(`data: ${JSON.stringify({ ...event(11), type: 'new.event' })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }) });
    await expect(unknown.subscribe(clientScope, 10, signal, () => undefined)).rejects.toMatchObject({ code: 'workspace_contract_mismatch' });
  });
});
