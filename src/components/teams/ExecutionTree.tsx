import { memo, useMemo, useState } from 'react';
import { taskDependencyLevels, taskDisplayReason, TEAM_STATUS_LABELS } from '../../core/teams/presentation.js';
import type { AgentMember, TeamTask, ExecutionNode, ExecutionSnapshot } from '../../core/teams/types.js';

export type ExecutionTreeProps = { tasks: TeamTask[]; members: AgentMember[]; selectedTaskId?: string; onSelect: (task: TeamTask) => void; execution?: ExecutionSnapshot | null; executionLoading?: boolean; executionError?: string; onRetryExecution?: () => void; onSelectNode?: (node: ExecutionNode) => void };
const NODE_WIDTH = 228;
const NODE_HEIGHT = 104;
const COLUMN_GAP = 72;
const ROW_GAP = 28;

/** Read-only dependency view. Every node is a persisted task; no simulated state. */
export const ExecutionTree = memo(function ExecutionTree({ tasks, members, selectedTaskId, onSelect, execution, executionLoading, executionError, onRetryExecution, onSelectNode }: ExecutionTreeProps) {
  const [view, setView] = useState<'graph' | 'list' | 'timeline' | 'invocations'>('graph');
  const [limit, setLimit] = useState(200);
  const layout = useMemo(() => {
    const { levels, invalidIds } = taskDependencyLevels(tasks);
    const nodes = levels.flatMap((level, column) => level.map((task, row) => ({ task, x: 32 + column * (NODE_WIDTH + COLUMN_GAP), y: 32 + row * (NODE_HEIGHT + ROW_GAP) })));
    return { nodes, invalidIds, width: Math.max(640, levels.length * (NODE_WIDTH + COLUMN_GAP)), height: Math.max(260, Math.max(0, ...levels.map(level => level.length)) * (NODE_HEIGHT + ROW_GAP) + 64) };
  }, [tasks]);
  const visibleNodes = layout.nodes.slice(0, limit);
  const positions = new Map(visibleNodes.map(node => [node.task.taskId, node]));
  return <div className="team-execution"><nav className="team-view-switch" aria-label="执行视图"><button type="button" aria-pressed={view === 'graph'} onClick={() => setView('graph')}>任务依赖</button><button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>任务列表</button><button type="button" aria-pressed={view === 'timeline'} onClick={() => setView('timeline')}>成员时间线</button>{(execution || executionLoading || executionError || onRetryExecution) && <button type="button" aria-pressed={view === 'invocations'} onClick={() => setView('invocations')}>执行调用</button>}</nav>
    {view === 'invocations' ? <InvocationTree execution={execution} loading={executionLoading} error={executionError} onRetry={onRetryExecution} onSelect={onSelectNode} /> : !tasks.length ? <div className="team-empty"><h3>尚无执行数据</h3><p>团队建立任务后，真实依赖与执行状态会显示在这里。</p></div> : view === 'list' ? <div className="team-execution-list">{tasks.slice(0, limit).map(task => <button type="button" key={task.taskId} onClick={() => onSelect(task)} aria-pressed={selectedTaskId === task.taskId}><strong>{task.title}</strong><span>{members.find(member => member.memberId === task.ownerMemberId)?.name || '待分派'}</span><span className="team-status" data-status={task.status}>{TEAM_STATUS_LABELS[task.status]}</span><small>{taskDisplayReason(task)}</small></button>)}</div> : view === 'timeline' ? <MemberTimeline tasks={tasks} members={members} onSelect={onSelect} /> : <>
      <p className="team-graph-caption">任务依赖决定等待顺序。选择任务查看执行与交付证据。</p>
      {!!layout.invalidIds.length && <p className="team-inline-error" role="alert">部分任务依赖缺失或存在循环，请通过任务列表检查。</p>}
      <div className="team-graph-scroll" tabIndex={0} aria-label="任务依赖图，可滚动查看"><svg width={layout.width} height={layout.height} role="group" aria-label="真实任务依赖关系">
        {visibleNodes.flatMap(node => node.task.dependencies.map(id => {
          const source = positions.get(id);
          if (!source) return null;
          const startX = source.x + NODE_WIDTH;
          const startY = source.y + NODE_HEIGHT / 2;
          const endY = node.y + NODE_HEIGHT / 2;
          return <path key={`${id}:${node.task.taskId}`} d={`M ${startX} ${startY} C ${startX + COLUMN_GAP / 2} ${startY}, ${node.x - COLUMN_GAP / 2} ${endY}, ${node.x} ${endY}`} className="team-graph-edge" aria-label={`${source.task.title} 完成后可开始 ${node.task.title}`} />;
        }))}
        {visibleNodes.map(node => <foreignObject key={node.task.taskId} x={node.x} y={node.y} width={NODE_WIDTH} height={NODE_HEIGHT}><button type="button" className="team-graph-node" data-status={node.task.status} aria-pressed={selectedTaskId === node.task.taskId} onClick={() => onSelect(node.task)}><span className="team-status" data-status={node.task.status}>{TEAM_STATUS_LABELS[node.task.status]}</span><strong>{node.task.title}</strong><small>{members.find(member => member.memberId === node.task.ownerMemberId)?.name || '待分派'}{taskDisplayReason(node.task) ? ` · ${taskDisplayReason(node.task)}` : ''}</small></button></foreignObject>)}
      </svg></div>
    </>}{tasks.length > limit && view !== 'timeline' && <button className="team-button team-history-more" type="button" onClick={() => { setView('list'); setLimit(value => value + 200); }}>已展示 {Math.min(limit, tasks.length)} / {tasks.length} 项，继续查看列表</button>}
  </div>;
});

export function MemberTimeline({ tasks, members, onSelect }: Omit<ExecutionTreeProps, 'selectedTaskId'>) {
  return <div className="team-member-timeline">{members.map(member => {
    const assigned = tasks.filter(task => task.ownerMemberId === member.memberId);
    return <section key={member.memberId}><h3>{member.name}<span>{member.role === 'leader' ? 'Leader' : '成员'}</span></h3>{!assigned.length ? <p className="team-muted">当前未分派任务</p> : assigned.map(task => {
      const attempt = task.attempts.at(-1);
      const start = attempt?.startedAt ? new Date(attempt.startedAt) : null;
      const end = attempt?.endedAt ? new Date(attempt.endedAt) : null;
      const duration = start && end && Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && end >= start ? Math.round((end.getTime() - start.getTime()) / 1000) : null;
      return <button type="button" className="team-timeline-task" key={task.taskId} onClick={() => onSelect(task)}><span className="team-status" data-status={task.status}>{TEAM_STATUS_LABELS[task.status]}</span><strong>{task.title}</strong><span>{start ? start.toLocaleTimeString() : '尚未开始'}{end ? ` → ${end.toLocaleTimeString()}` : start ? ' → 尚无结束事件' : ''}</span>{duration !== null && <small>{duration} 秒</small>}{taskDisplayReason(task) && <p>{taskDisplayReason(task)}</p>}</button>;
    })}</section>;
  })}</div>;
}

/** Host-projected run and child facts; task plans are labelled separately. */
export function InvocationTree({ execution, loading, error, onRetry, onSelect }: { execution?: ExecutionSnapshot | null; loading?: boolean; error?: string; onRetry?: () => void; onSelect?: (node: ExecutionNode) => void }) {
  const [limit, setLimit] = useState(200);
  const nodes = execution?.nodes ?? [];
  const rows: { node: ExecutionNode; depth: number }[] = [];
  const visited = new Set<string>();
  const walk = (node: ExecutionNode, depth: number) => { if (visited.has(node.nodeId) || rows.length >= limit) return; visited.add(node.nodeId); rows.push({ node, depth }); if (depth < 30) nodes.filter(child => child.parentNodeId === node.nodeId).forEach(child => walk(child, depth + 1)); };
  nodes.filter(node => !node.parentNodeId || !nodes.some(parent => parent.nodeId === node.parentNodeId)).forEach(node => walk(node, 0));
  nodes.filter(node => !visited.has(node.nodeId)).forEach(node => walk(node, 0));
  const labels = { task: '任务', run: '成员执行', child_invocation: '子执行' };
  const executionStatus: Record<string, string> = { running: '进行中', waiting: '等待中', awaiting_approval: '待审批', queued: '排队中', idle: '空闲', succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断', unavailable: '不可用' };
  return <section className="team-invocations" aria-label="真实执行调用链"><p className="team-graph-caption">执行与子调用来自运行记录；没有执行来源的任务仍是计划。</p>{loading && <p role="status" className="team-muted">正在读取执行记录…</p>}{error && <p role="alert" className="team-inline-error">{error} {onRetry && <button className="team-text-button" onClick={onRetry}>重试</button>}</p>}{!nodes.length && !loading && !error && <p className="team-muted">尚无已登记的执行调用。</p>}<ol className="team-invocation-list">{rows.map(({ node, depth }) => <li key={node.nodeId} style={{ paddingInlineStart: Math.min(depth, 10) * 14 }}><button type="button" className="team-invocation-node" data-kind={node.kind} data-planned={node.kind === 'task' && !node.source} onClick={() => onSelect?.(node)} disabled={!onSelect || (!node.taskId && !node.source)}><span className="team-eyebrow">{labels[node.kind]}{node.kind === 'task' && !node.source ? ' · 尚未执行' : ''}</span><strong>{node.title}</strong><span className="team-status" data-status={node.status}>{(node.kind === 'task' ? TEAM_STATUS_LABELS[node.status as keyof typeof TEAM_STATUS_LABELS] : executionStatus[node.status]) || node.status}</span>{(node.kind === 'task' ? taskDisplayReason(node) : node.reason) && <small>{node.kind === 'task' ? taskDisplayReason(node) : node.reason}</small>}</button></li>)}</ol>{nodes.length > limit && <button className="team-button" onClick={() => setLimit(value => value + 200)}>继续查看执行记录</button>}</section>;
}
