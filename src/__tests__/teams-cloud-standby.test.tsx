import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { cloudTeamScope, cloudTeamSnapshot } from '../../e2e/fixtures/cloud-teams-data.js';
import { decodeTeamWorkspaceSnapshot, type WorkspaceLeaderStandby, type WorkspaceEvent } from '../core/teams/workspaceContracts.js';
import { WorkspaceReducer } from '../core/teams/workspaceReducer.js';
import { WorkspaceObserver } from '../core/teams/workspaceObserver.js';
import { CloudTeamWorkspaceView } from '../components/teams/CloudTeamWorkspace.js';

const scope = cloudTeamScope();
const standby = (state: WorkspaceLeaderStandby['state'] = 'armed'): WorkspaceLeaderStandby => ({ state, standbyBindingRef: 'cloud-frozen-standby', releaseRef: 'frozen-release', takeoverId: null, reason: null, newLeaderEpoch: null });
function snapshot(value?: WorkspaceLeaderStandby) {
  const data = cloudTeamSnapshot();
  if (value) {
    data.selectedRun = { ...data.selectedRun!, leaderStandby: value };
    data.runSummaries = data.runSummaries.map(run => run.teamRunId === data.selectedRun!.teamRunId ? data.selectedRun! : run);
  }
  return decodeTeamWorkspaceSnapshot(data);
}
function markup(value?: WorkspaceLeaderStandby, newGoal = false) {
  const projection = new WorkspaceReducer(snapshot(value)).projection();
  return renderToStaticMarkup(<CloudTeamWorkspaceView observation={{ scope, projection, selectedRunId: projection.snapshot.selectedRun!.teamRunId, connection: 'connected', draft: '', errorCode: null, loadingPages: [] }} canWrite={false} newGoal={newGoal} onRetry={() => {}} onLoadMore={() => {}} onChooseRun={() => {}} onNewGoal={() => {}} />);
}
function delta(groupSeq: number, changes: WorkspaceEvent['changes']): WorkspaceEvent {
  return { apiVersion: 'teams.ksadk.io/v1', viewVersion: 'workspace/v1', scope: snapshot().scope, eventId: `takeover-${groupSeq}`, groupSeq, createdAt: '2026-09-18T08:00:00Z', type: 'workspace.delta', changes };
}
function hold(signal: AbortSignal): Promise<void> { return new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve(), { once: true })); }

describe('Cloud Leader standby projection', () => {
  it.each([
    ['armed', '已配置备用 Leader'], ['fencing_old', '正在停止原 Leader'], ['waiting_old_grant', '等待原授权失效'],
    ['activating', '正在启动备用 Leader'], ['active', '备用 Leader 已接管'], ['blocked', 'Leader 接管暂时受阻'],
  ] as const)('decodes and presents %s without exposing a takeover command', (state, label) => {
    expect(snapshot(standby(state)).selectedRun?.leaderStandby?.state).toBe(state);
    const html = markup(standby(state)); expect(html).toContain(label);
    expect(html).not.toContain('cloud-frozen-standby'); expect(html).not.toContain('frozen-release');
    const section = html.match(/<section class="team-cloud-standby".*?<\/section>/)?.[0];
    expect(section).toBeDefined(); expect(section).not.toContain('<button');
  });
  it('omits unconfigured standby and does not mix the previous run into a new goal', () => {
    expect(markup()).not.toContain('Leader 接管状态'); expect(markup(standby(), true)).not.toContain('Leader 接管状态');
  });
  it('shows actionable known reasons and safely escapes unknown server reasons', () => {
    expect(markup({ ...standby('blocked'), reason: 'effect_reconciliation_required' })).toContain('核对后才能继续接管');
    const html = markup({ ...standby('blocked'), reason: '<script>unknown</script>' });
    expect(html).toContain('服务端原因：&lt;script&gt;unknown&lt;/script&gt;'); expect(html).not.toContain('<script>');
  });
  it('rejects unknown fields, states, missing fields and unsafe epochs', () => {
    for (const patch of [{ state: 'finished' }, { token: 'forged' }, { takeoverId: undefined }, { newLeaderEpoch: 0 }, { newLeaderEpoch: Number.MAX_SAFE_INTEGER + 1 }, { reason: 'x'.repeat(2001) }]) {
      expect(() => snapshot({ ...standby(), ...patch } as WorkspaceLeaderStandby)).toThrow();
    }
  });
  it('orders derived standby changes by event sequence without altering run CAS revision', () => {
    const initial = snapshot(standby()); const reducer = new WorkspaceReducer(initial);
    const request = reducer.pageRequest('runSummaries')!;
    expect(request).not.toBeNull();
    const updated = { ...initial.selectedRun!, leaderStandby: { ...standby('waiting_old_grant'), takeoverId: 'takeover-a', newLeaderEpoch: 2 } };
    reducer.apply(delta(initial.watermark + 1, [{ kind: 'run', run: updated }]));
    reducer.mergePage(request, { apiVersion: initial.apiVersion, viewVersion: initial.viewVersion, scope: initial.scope, ...request, nextCursor: null, items: initial.runSummaries });
    expect(reducer.snapshot().selectedRun).toEqual(updated);
    expect(reducer.snapshot().runSummaries.find(run => run.teamRunId === updated.teamRunId)).toEqual(updated);
  });
  it('re-reads on takeover invalidation and clears standby while switching to another run', async () => {
    const first = snapshot(standby()); const refreshed = snapshot({ ...standby('blocked'), reason: 'effect_reconciliation_required' });
    refreshed.watermark++; refreshed.snapshotId = 'fresh-standby';
    const second = snapshot(); second.selectedRun!.teamRunId = 'another-run'; second.runSummaries = [second.selectedRun!];
    second.selectedRunMembers.forEach(row => { row.teamRunId = 'another-run'; });
    for (const rows of [second.recentMessages, second.taskSummaries, second.pendingInteractions, second.artifactSummaries]) rows.forEach(row => { row.teamRunId = 'another-run'; });
    let reads = 0; let streams = 0; let releaseRead!: () => void;
    const read = vi.fn(async (_scope, options) => {
      if (options.teamRunId === 'another-run') { await new Promise<void>(resolve => { releaseRead = resolve; }); return second; }
      return reads++ ? refreshed : first;
    });
    const observer = new WorkspaceObserver(scope, { read, page: vi.fn(), subscribe: vi.fn(async (_scope, _seq, signal, onEvent) => {
      if (++streams === 1) onEvent(delta(first.watermark + 1, [{ kind: 'invalidate', teamRunId: first.selectedRun!.teamRunId, collections: ['runSummaries'] }]));
      await hold(signal);
    }) });
    const running = observer.observe(first.selectedRun!.teamRunId);
    await vi.waitFor(() => expect(observer.getSnapshot().projection?.snapshot.selectedRun?.leaderStandby?.state).toBe('blocked'));
    const other = observer.observe('another-run');
    expect(observer.getSnapshot().projection).toBeNull();
    releaseRead(); await running;
    await vi.waitFor(() => expect(observer.getSnapshot().projection?.snapshot.selectedRun?.teamRunId).toBe('another-run'));
    expect(observer.getSnapshot().projection?.snapshot.selectedRun?.leaderStandby).toBeUndefined();
    observer.dispose(); await other;
  });
});
