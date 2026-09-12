import type { GroupSnapshot, TeamTask, TaskStatus, TeamStatus } from './types.js';

export const TEAM_STATUS_LABELS: Record<TeamStatus | TaskStatus, string> = {
  draft: '计划中', ready: '待开始', blocked: '等待依赖', planning: '规划中', running: '进行中', waiting: '等待中', needs_attention: '需要处理', awaiting_acceptance: '待验收', succeeded: '已验收', failed: '失败', cancel_requested: '正在请求停止', cancelled: '已取消',
};
export const isTeamRunActive = (status: string) => !['succeeded', 'failed', 'cancelled'].includes(status);
export function currentTeamRun(snapshot: GroupSnapshot) {
  return snapshot.teamRuns.find(run => isTeamRunActive(run.status)) ?? snapshot.teamRuns.at(-1) ?? null;
}
export function taskSection(task: TeamTask): 'attention' | 'running' | 'waiting' | 'done' {
  if (['failed', 'awaiting_acceptance'].includes(task.status)) return 'attention';
  if (['running', 'cancel_requested'].includes(task.status)) return 'running';
  if (['succeeded', 'cancelled'].includes(task.status)) return 'done';
  return 'waiting';
}
/** A completed candidate supersedes an earlier approval wait; retain failure details. */
export function taskDisplayReason(task: { status: string; reason?: string | null }): string | undefined {
  if (task.reason === '等待人工审批' && ['awaiting_acceptance', 'succeeded'].includes(task.status)) return undefined;
  return task.reason ?? undefined;
}
export function safeArtifactUri(uri?: string | null): string | null {
  if (!uri) return null;
  try { const url = new URL(uri); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}

/** Stable dependency levels. Invalid cycles remain explicit, never fake a graph. */
export function taskDependencyLevels(tasks: TeamTask[]): { levels: TeamTask[][]; invalidIds: string[] } {
  const ids = new Set(tasks.map(task => task.taskId));
  const pending = new Map(tasks.map(task => [task.taskId, task]));
  const complete = new Set<string>();
  const levels: TeamTask[][] = [];
  while (pending.size) {
    const level = [...pending.values()].filter(task => task.dependencies.every(id => ids.has(id) && complete.has(id)));
    if (!level.length) break;
    levels.push(level);
    level.forEach(task => { complete.add(task.taskId); pending.delete(task.taskId); });
  }
  return { levels, invalidIds: [...pending.keys()] };
}
