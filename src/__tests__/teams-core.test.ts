import { describe, expect, it, vi } from 'vitest';
import { createChatScope, decodeExecutionSnapshot, decodeGroupSnapshot, GroupReducer, HttpTeamsClient, interactionRefKey, taskDependencyLevels, TeamsError, TEAMS_API_VERSION, validateGroupCreate, type GroupSnapshot, type MemberStreamRef } from '../public/teams.js';
import type { ConversationItem } from '../core/conversation/types.js';
import { memberRef, teamEvent, teamSnapshot } from '../../e2e/fixtures/teams-data.js';

function item(ref: MemberStreamRef, text = 'same answer', eventId = 'source-1'): ConversationItem { return { apiVersion: 'conversation.ksadk.io/v1', kindVersion: 1, itemId: 'same-item', sourceEventIds: [eventId], sessionId: ref.sessionId, runId: ref.runId, kind: 'assistant_text', operation: 'append', lifecycle: 'streaming', visibility: 'public', payloadSchemaRef: 'conversation.item.assistant_text/v1', payload: { text }, nativeRef: {} }; }
function sse(data: unknown, type = 'message') { return new Response(`event: ${type}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`, { headers: { 'Content-Type': 'text/event-stream' } }); }

describe('Teams group contracts and replay', () => {
  it('preserves unknown future fields but rejects another group inside the snapshot', () => {
    const input = { ...teamSnapshot(), futureFeature: { enabled: true } };
    expect(decodeGroupSnapshot(input)).toHaveProperty('futureFeature');
    input.members[0].groupId = 'other';
    expect(() => decodeGroupSnapshot(input)).toThrow(/作用域/);
  });
  it('rejects artifact provenance from another group in snapshots and replay', () => {
    const snapshot = teamSnapshot();
    const task = { ...snapshot.tasks[1], revision: 2, attempts: [{ ...snapshot.tasks[1].attempts[0], artifacts: [{ artifactId: 'foreign', name: 'private.md', mediaType: 'text/markdown', source: { ...memberRef(), groupId: 'other-group' } }] }] };
    expect(() => decodeGroupSnapshot({ ...snapshot, tasks: [task] })).toThrow(TeamsError);
    expect(() => new GroupReducer(snapshot).apply(teamEvent(1, 'task.updated', { task }))).toThrow(TeamsError);
  });
  it('replays immutable shared artifacts and checks their authorization scope', () => {
    const artifact = { artifactId: 'shared-file', name: 'review.md', mediaType: 'text/markdown', source: memberRef() };
    const reducer = new GroupReducer(teamSnapshot());
    reducer.apply(teamEvent(1, 'artifact.updated', { artifact }));
    reducer.apply(teamEvent(2, 'artifact.updated', { artifact }));
    expect(reducer.snapshot().artifacts).toEqual([artifact]);
    expect(decodeGroupSnapshot(reducer.snapshot()).artifacts).toEqual([artifact]);
    expect(() => decodeGroupSnapshot({ ...teamSnapshot(), artifacts: [{ ...artifact, source: { ...artifact.source, authorityRef: 'foreign' } }] })).toThrow(/作用域/);
    expect(() => reducer.apply(teamEvent(3, 'artifact.updated', { artifact: { ...artifact, source: { ...artifact.source, groupId: 'foreign' } } }))).toThrow(/作用域/);
    expect(reducer.snapshot().watermark).toBe(2);
  });
  it('rejects duplicate stable identities and malformed capabilities', () => {
    const input = teamSnapshot(); input.members.push(input.members[0]);
    expect(() => decodeGroupSnapshot(input)).toThrow(/重复/);
    expect(() => decodeGroupSnapshot({ ...teamSnapshot(), watermark: -1 })).toThrow(TeamsError);
  });
  it('replays one message once, keeps equal-text distinct messages and replaces by revision', () => {
    const reducer = new GroupReducer(teamSnapshot());
    const message = { ...teamSnapshot().messages[0], messageId: 'm-a' };
    const first = teamEvent(1, 'message.created', { message });
    expect(reducer.apply(first)).toBe(true);
    expect(reducer.apply(first)).toBe(false);
    reducer.apply(teamEvent(2, 'message.created', { message: { ...message, messageId: 'm-b' } }));
    reducer.apply(teamEvent(3, 'message.updated', { message: { ...message, revision: 2, parts: [{ kind: 'text', text: 'complete' }] } }));
    reducer.apply(teamEvent(4, 'message.updated', { message }));
    expect(reducer.snapshot().messages).toHaveLength(4);
    expect(reducer.snapshot().messages.find(row => row.messageId === 'm-a')?.parts).toEqual([{ kind: 'text', text: 'complete' }]);
  });
  it('requires a fresh snapshot when a sequence gap occurs and never applies partial state', () => {
    const reducer = new GroupReducer(teamSnapshot());
    expect(() => reducer.apply(teamEvent(2))).toThrow(/缺口/);
    expect(reducer.snapshot().watermark).toBe(0);
    expect(() => reducer.apply({ ...teamEvent(1), groupId: 'other' })).toThrow(/当前群/);
  });
  it('rejects nested cross-group events and keeps original watermark on failure', () => {
    const reducer = new GroupReducer(teamSnapshot());
    expect(() => reducer.apply(teamEvent(1, 'task.updated', { task: { ...teamSnapshot().tasks[0], groupId: 'other' } }))).toThrow(/作用域/);
    expect(reducer.snapshot().watermark).toBe(0);
  });
  it('does not let stale snapshots replace live state, or changed authority reuse a reducer', () => {
    const reducer = new GroupReducer(teamSnapshot());
    reducer.apply(teamEvent(1, 'future.event', { rendererUrl: 'https://invalid.example/plugin.js' }));
    expect(reducer.snapshot().watermark).toBe(1);
    expect(reducer.replace(teamSnapshot())).toBe(false);
    const other = teamSnapshot(); other.group.authorityRef = 'other';
    expect(() => reducer.replace(other)).toThrow(/授权域/);
  });
  it('validates Leader membership and missing or cyclic dependencies', () => {
    expect(() => validateGroupCreate({ name: 'Team', members: [{ memberId: 'a' }], leaderMemberId: 'b' })).toThrow(/Leader/);
    const tasks = teamSnapshot().tasks;
    expect(taskDependencyLevels(tasks).levels).toHaveLength(3);
    tasks[0].dependencies = [tasks[2].taskId];
    expect(taskDependencyLevels(tasks).invalidIds).toHaveLength(3);
  });
  it('handles ten thousand ordered events without losing unique message identities', () => {
    const reducer = new GroupReducer(teamSnapshot());
    const original = teamSnapshot().messages[0];
    for (let seq = 1; seq <= 10_000; seq++) reducer.apply(teamEvent(seq, 'message.created', { message: { ...original, messageId: `stress-${seq}` } }));
    expect(reducer.snapshot().watermark).toBe(10_000);
    expect(reducer.snapshot().messages).toHaveLength(10_002);
  });
});

describe('Teams transport', () => {
  it('watches from the snapshot watermark, resets expired cursors and never submits a new goal', async () => {
    const abort = new AbortController();
    const reset = teamSnapshot(); reset.watermark = 7;
    const requests: string[] = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      requests.push(`${init?.method ?? 'GET'} ${url}`);
      if (requests.length === 1) return Response.json(teamSnapshot());
      if (requests.length === 2) return sse({}, 'reset_required');
      if (requests.length === 3) return Response.json(reset);
      return sse(teamEvent(8, 'future.event'));
    });
    const seen: GroupSnapshot[] = [];
    const client = new HttpTeamsClient({ fetch: fetcher, retryDelayMs: () => 0 });
    await client.watch('fixture-group', { signal: abort.signal, onSnapshot: snapshot => { seen.push(snapshot); if (snapshot.watermark === 8) abort.abort(); } });
    expect(seen.map(row => row.watermark)).toEqual([0, 7, 8]);
    expect(requests).toEqual(['GET /api/v1/groups/fixture-group', 'GET /api/v1/groups/fixture-group/events?after=0', 'GET /api/v1/groups/fixture-group', 'GET /api/v1/groups/fixture-group/events?after=7']);
  });
  it('reconnects with the last event watermark rather than resending the input', async () => {
    const abort = new AbortController();
    const requests: string[] = [];
    const client = new HttpTeamsClient({ retryDelayMs: () => 0, fetch: async url => { requests.push(url); return requests.length === 1 ? Response.json(teamSnapshot()) : sse(teamEvent(requests.length - 1, 'future.event')); } });
    await client.watch('fixture-group', { signal: abort.signal, onSnapshot: snapshot => { if (snapshot.watermark === 2) abort.abort(); } });
    expect(requests[2]).toBe('/api/v1/groups/fixture-group/events?after=1');
  });
  it('does not regress to a stale snapshot after the server expires a cursor', async () => {
    const newer = teamSnapshot(); newer.watermark = 10;
    let requests = 0;
    const observed: number[] = [];
    const client = new HttpTeamsClient({ maxReconnects: 1, retryDelayMs: () => 0, fetch: async () => { requests++; return requests === 1 ? Response.json(newer) : requests === 2 ? sse({}, 'reset_required') : Response.json(teamSnapshot()); } });
    await expect(client.watch('fixture-group', { signal: new AbortController().signal, onSnapshot: value => observed.push(value.watermark) })).rejects.toThrow(/早于当前状态/);
    expect(observed).toEqual([10]);
  });
  it('reports connection failure without changing a running TeamRun to failed', async () => {
    const states: string[] = [];
    let seen: GroupSnapshot | null = null;
    let count = 0;
    const client = new HttpTeamsClient({ maxReconnects: 0, fetch: async () => { if (!count++) return Response.json(teamSnapshot()); throw new Error('offline'); } });
    await expect(client.watch('fixture-group', { signal: new AbortController().signal, onSnapshot: value => { seen = value; }, onConnection: value => states.push(value) })).rejects.toThrow('offline');
    expect(states.at(-1)).toBe('offline');
    expect((seen as GroupSnapshot | null)?.teamRuns[0].status).toBe('running');
  });
  it('keeps a complete immutable interaction reference through the action', async () => {
    const fetcher = vi.fn(async () => Response.json({ status: 'accepted', groupId: 'fixture-group' }));
    const client = new HttpTeamsClient({ fetch: fetcher });
    const ref = { ...memberRef(), interactionId: 'approval' };
    const input = { ref, expectedRevision: 4, action: 'approve' as const, response: { approved: true }, idempotencyKey: 'same-decision' };
    await client.interaction('fixture-group', input);
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual(input);
    expect(() => client.interaction('other', input)).toThrow(/当前群/);
    expect(interactionRefKey(ref)).not.toBe(interactionRefKey({ ...memberRef('leader'), interactionId: 'approval' }));
  });
  it('cancels one exact member Run using the full reference and caller idempotency key', async () => {
    const fetcher = vi.fn(async () => Response.json({ status: 'cancel_requested', runId: memberRef().runId }, { status: 202 }));
    const client = new HttpTeamsClient({ fetch: fetcher });
    const input = { ref: memberRef(), idempotencyKey: 'cancel-once' };
    expect(await client.cancelMember('fixture-group', 'engineer', input)).toEqual({ status: 'cancel_requested', runId: memberRef().runId });
    expect(fetcher.mock.calls[0][0]).toBe('/api/v1/groups/fixture-group/members/engineer/cancel');
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual(input);
    expect(() => client.cancelMember('fixture-group', 'leader', input)).toThrow(/当前成员/);
    expect(() => client.cancelMember('foreign', 'engineer', input)).toThrow(/当前成员/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('directed input is explicitly routed through the group API', async () => {
    const fetcher = vi.fn(async () => Response.json({ status: 'accepted', groupId: 'fixture-group' }));
    const client = new HttpTeamsClient({ fetch: fetcher });
    await client.send('fixture-group', { intent: 'directed', mentions: ['engineer'], parts: [{ kind: 'text', text: 'check' }], idempotencyKey: 'directed-1' });
    expect(fetcher.mock.calls[0][0]).toBe('/api/v1/groups/fixture-group/messages');
    expect(() => client.send('fixture-group', { intent: 'directed', mentions: [], parts: [{ kind: 'text', text: 'check' }], idempotencyKey: 'bad' })).toThrow(/接收成员/);
  });
});

describe('Member observation and scope isolation', () => {
  it('isolates same item IDs and text across concurrently observed members', () => {
    const first = createChatScope(memberRef()); const second = createChatScope(memberRef('leader'));
    first.setDraft('private draft');
    first.ingest({ ref: memberRef(), cursor: 1, item: item(memberRef()) });
    second.ingest({ ref: memberRef('leader'), cursor: 1, item: item(memberRef('leader')) });
    first.ingest({ ref: memberRef(), cursor: 2, item: item(memberRef(), ' more', 'source-2') });
    expect(first.getSnapshot().items[0].payload.text).toBe('same answer more');
    expect(second.getSnapshot().items[0].payload.text).toBe('same answer');
    expect(second.getSnapshot().draft).toBe('');
    first.dispose();
    expect(first.getSnapshot().draft).toBe('');
    expect(first.getSnapshot().items).toEqual([]);
    expect(second.getSnapshot().items).toHaveLength(1);
  });
  it('rejects another session/run even if the member envelope looks correct', () => {
    const scope = createChatScope(memberRef());
    expect(() => scope.ingest({ ref: memberRef(), cursor: 1, item: item(memberRef('leader')) })).toThrow(/其他会话/);
    expect(scope.getSnapshot().cursor).toBe(0);
  });
  it('attaches to history and ignores late callbacks after disposal without cancelling the Run', async () => {
    const ref = memberRef(); const scope = createChatScope(ref);
    let deliver: ((value: unknown) => void) | undefined;
    const transport = { read: vi.fn(async () => ({ ref, cursor: 1, items: [item(ref)] })), subscribe: vi.fn(async (_ref: MemberStreamRef, _after: number, signal: AbortSignal, onFrame: (frame: never) => void) => { deliver = onFrame as (value: unknown) => void; await new Promise(resolve => signal.addEventListener('abort', resolve)); }) };
    const observed = scope.observe(transport);
    await vi.waitFor(() => expect(transport.subscribe).toHaveBeenCalled());
    scope.dispose();
    deliver?.({ ref, cursor: 2, item: item(ref, 'late', 'source-2') });
    await observed;
    expect(scope.getSnapshot().items).toEqual([]);
    expect(Object.keys(transport)).toEqual(['read', 'subscribe']);
  });
  it('exports the new wire version without changing conversation v1', () => { expect(TEAMS_API_VERSION).toBe('teams.ksadk.io/v1'); });
});


describe('execution projection contract', () => {
  it('accepts nullable plan metadata and retains actual child invocation provenance', () => {
    const execution = { groupId: 'fixture-group', teamRunId: 'team-run', watermark: 3, nodes: [{ nodeId: 'task', kind: 'task', title: '待分派', status: 'draft', memberId: null, reason: null }, { nodeId: 'child', kind: 'child_invocation', title: '子执行', status: 'running', parentNodeId: 'task', source: memberRef() }], edges: [{ source: 'task', target: 'child', kind: 'invocation' }] };
    expect(decodeExecutionSnapshot(execution).nodes[1].source).toEqual(memberRef());
    expect(() => decodeExecutionSnapshot({ ...execution, nodes: [...execution.nodes, execution.nodes[0]] })).toThrow(TeamsError);
    expect(() => decodeExecutionSnapshot({ ...execution, edges: [{ source: 'missing', target: 'child', kind: 'invocation' }] })).toThrow(TeamsError);
    expect(() => decodeExecutionSnapshot({ ...execution, nodes: [{ ...execution.nodes[1], source: { ...memberRef(), groupId: 'other-group' } }] })).toThrow(TeamsError);
  });
});
