import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CloudMaterialUpload, materialIsBusy } from '../../core/teams/cloudMaterials.js';
import { CloudOperations } from '../../core/teams/cloudOperations.js';
import type { HttpCloudTeamsProductClient, CloudInteractionDetail } from '../../core/teams/cloudProductClient.js';
import type { CloudWorkspaceTransport } from '../../core/teams/cloudClient.js';
import type { TeamsOperationPayload } from '../../core/teams/operationOutbox.js';
import { WorkspaceObserver, type WorkspaceObservation } from '../../core/teams/workspaceObserver.js';
import { workspaceClientScopeKey, workspaceInteractionKey, type WorkspaceClientScope, type WorkspaceCollection, type WorkspaceInteraction, type WorkspaceTaskSummary, type WorkspaceLeaderStandby } from '../../core/teams/workspaceContracts.js';
import { isTeamRunActive } from '../../core/teams/presentation.js';
import { MessageMarkdown } from '../MessageMarkdown.js';
import { schemaFields } from '../chat/schema-fields.js';
import { InteractionSchemaForm } from '../chat/InteractionSchemaForm.js';
import { InteractionMessage } from './InteractionMessage.js';
import { CloudEffectsPanel } from './CloudEffectsPanel.js';
import { useImeComposition } from '../../hooks/useImeComposition.js';
import { TaskDetail, TeamStatusLabel } from './TeamWorkspace.js';
import type { TeamTask } from '../../core/teams/types.js';

type Resources = { observer: WorkspaceObserver; operations: CloudOperations | null };
const emptyQueue = { operations: [], recovering: false, errorCode: null };
const noSubscribe = () => () => {};
const emptyQueueSnapshot = () => emptyQueue;
export interface CloudTeamWorkspaceProps {
  scope: WorkspaceClientScope;
  transport: CloudWorkspaceTransport;
  product: HttpCloudTeamsProductClient;
  canWrite: boolean;
  effectsEnabled?: boolean;
  readOnlyReason?: string;
  initialRunId?: string;
  onSelectionChange?: (teamRunId: string | null) => void;
  onChanged?: () => void;
}
const operationLabel = (operation: string) => operation.endsWith('/messages') ? '团队消息' : operation.endsWith('/control') ? '任务控制' : operation.endsWith('/interactions') ? '审批回复' : operation.endsWith('/acceptance') ? '任务验收' : operation.endsWith('/actions') ? '子任务操作' : operation.endsWith('/reconcile') ? '执行核查决定' : '创建团队';
const operationStatus = { queued: '等待提交', sending: '正在核对原单', confirmed: '服务端已接收', rejected: '请求被拒绝', uncertain: '接收结果未确认' };
const connectionText = { connecting: '正在读取工作区', connected: '实时连接', reconnecting: '正在恢复连接 · 执行状态待同步', offline: '连接中断 · 显示最后同步状态', closed: '尚未连接' };
const executionText = { idle: '空闲', queued: '排队中', running: '执行中', waiting: '等待中', needs_attention: '需要处理', unavailable: '不可用' };
const executionReason = (reason: string) => reason === 'execution_preparation_expired' ? '准备时间过长，执行授权已过期。尚未开始执行，可重新提交请求或重试任务。' : reason;

const standbyStates: Record<WorkspaceLeaderStandby['state'], { label: string; description: string }> = {
  armed: { label: '已配置备用 Leader', description: '已配置备用执行端，当前仍由原 Leader 负责。' },
  fencing_old: { label: '正在停止原 Leader', description: '正在撤销原执行授权，确认后再启动备用 Leader。' },
  waiting_old_grant: { label: '等待原授权失效', description: '原执行授权尚未确认结束，备用 Leader 暂不执行。' },
  activating: { label: '正在启动备用 Leader', description: '原授权已隔离，正在恢复本轮任务上下文。' },
  active: { label: '备用 Leader 已接管', description: '当前由备用 Leader 继续处理本轮任务。' },
  blocked: { label: 'Leader 接管暂时受阻', description: '接管条件尚未满足，需要先处理以下原因。' },
};
const standbyReasons: Record<string, string> = {
  effect_reconciliation_required: '存在结果未确认的外部操作，核对后才能继续接管。',
  release_verification_required: '尚未确认备用执行端与原 Leader 使用相同的发布内容。',
  standby_probe_unavailable: '暂时无法确认备用执行端的可用状态。',
  standby_capability_unavailable: '备用执行端暂不具备本轮任务所需的能力。',
  binding_revision_mismatch: '执行端配置已变化，需要重新验证。',
  standby_binding_mismatch: '备用执行端与本轮任务的预设配置不一致。',
  original_context_unavailable: '原执行上下文暂不可用。',
  grant_lookup_uncertain: '原执行授权的状态尚未确认。',
  material_not_ready: '任务材料尚未准备就绪。',
  leader_takeover_conflict: '本轮任务状态已变化，暂时不能接管。',
};
function CloudLeaderStandby({ value }: { value: WorkspaceLeaderStandby }) {
  const state = standbyStates[value.state];
  return <section className="team-cloud-standby" aria-label="Leader 接管状态" data-state={value.state} role="status">
    <strong>{state.label}</strong><p>{state.description}</p>
    {value.reason && <p className="team-cloud-standby-reason">{standbyReasons[value.reason] || `服务端原因：${value.reason}`}</p>}
  </section>;
}

/** Cloud view owns a partial projection. It never constructs a legacy GroupSnapshot. */
export function CloudTeamWorkspace(props: CloudTeamWorkspaceProps) {
  const [resources, setResources] = useState<Resources | null>(null);
  const [startupError, setStartupError] = useState('');
  const identity = workspaceClientScopeKey(props.scope);
  useEffect(() => {
    let operations: CloudOperations | undefined;
    let alive = true;
    const observer = new WorkspaceObserver(props.scope, props.transport);
    const initialize = async () => {
      try {
        operations = new CloudOperations({ scope: props.scope }, props.product); operations.setWritable(false);
        await operations.refresh();
        if (alive) { setResources({ observer, operations }); setStartupError(''); }
      } catch {
        operations?.dispose();
        if (alive) { setStartupError('当前浏览器无法打开持久操作存储，工作区仅供查看。'); setResources({ observer, operations: null }); }
      }
    };
    void initialize(); void observer.observe(props.initialRunId);
    return () => { alive = false; observer.dispose(); operations?.dispose(); };
    // The component is keyed by authenticated scope by the host. Run selection stays inside the observer.
  }, [identity, props.transport, props.product]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!resources || workspaceClientScopeKey(resources.observer.scope) !== identity) return <section className="ksadk-teams team-workspace"><p role={startupError ? 'alert' : 'status'} className="team-cloud-notice">{startupError || '正在准备团队工作区…'}</p></section>;
  return <ConnectedCloudWorkspace {...props} readOnlyReason={startupError || props.readOnlyReason} resources={resources} />;
}

function ConnectedCloudWorkspace({ resources, ...props }: CloudTeamWorkspaceProps & { resources: Resources }) {
  const { observer, operations } = resources;
  const { onSelectionChange, onChanged } = props;
  const observation = useSyncExternalStore(observer.subscribe, observer.getSnapshot, observer.getSnapshot);
  const queue = useSyncExternalStore(operations?.subscribe ?? noSubscribe, operations?.getSnapshot ?? emptyQueueSnapshot, operations?.getSnapshot ?? emptyQueueSnapshot);
  const [error, setError] = useState('');
  const [newGoal, setNewGoal] = useState(false);
  const [goalDraft, setGoalDraft] = useState('');
  const [awaitingMessageId, setAwaitingMessageId] = useState<string | null>(null);
  const selectionEpoch = useRef(0);
  const [browserOnline, setBrowserOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  useEffect(() => { const sync = () => setBrowserOnline(navigator.onLine); window.addEventListener('online', sync); window.addEventListener('offline', sync); return () => { window.removeEventListener('online', sync); window.removeEventListener('offline', sync); }; }, []);
  const archived = observation.projection?.snapshot.group.status === 'archived';
  const writable = Boolean(operations) && browserOnline && !archived && props.canWrite && observation.connection === 'connected';
  useEffect(() => { if (!operations) return; operations.setWritable(writable); if (writable) void operations.recover(); else void operations.refresh(); }, [operations, writable]);
  useEffect(() => {
    if (!operations) return;
    const refresh = () => { void operations.refresh(); if (document.visibilityState === 'visible' && navigator.onLine && writable) void operations.recover(); };
    window.addEventListener('online', refresh); window.addEventListener('focus', refresh);
    const timer = window.setInterval(refresh, 15_000);
    return () => { window.removeEventListener('online', refresh); window.removeEventListener('focus', refresh); clearInterval(timer); };
  }, [operations, writable]);
  async function command(suffix: string, payload: TeamsOperationPayload) {
    if (!writable || !operations) throw new Error('当前为只读状态，请恢复连接后重试。');
    setError('');
    const result = await operations.submit({ operation: `groups/${props.scope.groupId}/${suffix}`, payload });
    if (suffix === 'messages' && !['confirmed', 'rejected'].includes(result.status)) setAwaitingMessageId(result.operationId);
    if (result.status !== 'confirmed') throw new Error(result.status === 'rejected' ? `请求未被接受（${result.errorCode || 'operation_rejected'}）。` : '已保存操作，接收结果尚未确认。请在操作记录中核对原单，不要重复创建目标。');
    props.onChanged?.(); observer.refresh();
    return result;
  }
  useEffect(() => {
    if (!operations || !awaitingMessageId) return;
    return operations.subscribe(() => {
      const row = operations.getSnapshot().operations.find(operation => operation.operationId === awaitingMessageId);
      if (!row || !['confirmed', 'rejected'].includes(row.status)) return;
      setAwaitingMessageId(null);
      if (row.status === 'rejected') return;
      setError('');
      const current = observer.getSnapshot();
      const parts = row.payload.parts;
      const submittedText = Array.isArray(parts) ? parts.filter(part => part && typeof part === 'object' && !Array.isArray(part) && part.kind === 'text').map(part => (part as { text: string }).text).join('') : '';
      const starting = row.payload.intent === 'start_goal';
      const sameDraft = starting ? goalDraft.trim() === submittedText : current.selectedRunId === row.payload.teamRunId && current.draft.trim() === submittedText;
      if (starting && sameDraft) { setGoalDraft(''); setNewGoal(false); }
      if (!starting && typeof row.payload.teamRunId === 'string') observer.acknowledgeDraft(row.payload.teamRunId, submittedText);
      const runId = row.receipt?.teamRunId;
      if (typeof runId === 'string' && sameDraft && (!starting || newGoal)) { void observer.observe(runId); onSelectionChange?.(runId); }
      else observer.refresh();
      onChanged?.();
    });
  }, [operations, observer, awaitingMessageId, goalDraft, newGoal, onSelectionChange, onChanged]);
  const pendingMessage = queue.operations.some(operation => operation.operation.endsWith('/messages') && !['confirmed', 'rejected'].includes(operation.status) && (newGoal ? operation.payload.intent === 'start_goal' : operation.payload.teamRunId === observation.selectedRunId || (!observation.selectedRunId && operation.payload.intent === 'start_goal')));
  const chooseRun = (id: string) => { selectionEpoch.current++; setNewGoal(false); setError(''); void observer.observe(id); props.onSelectionChange?.(id); };
  return <CloudTeamWorkspaceView observation={observation} canWrite={writable} readOnlyReason={!browserOnline ? '浏览器已离线，草稿与待确认操作会保留。' : archived ? '团队已归档，历史记录仍可查看。' : props.readOnlyReason} onRetry={() => observer.refresh()} onLoadMore={collection => { void observer.loadMore(collection).catch(() => setError('分页读取失败。可重试；快照过期时会自动重新同步。')); }} onChooseRun={chooseRun} onNewGoal={() => { selectionEpoch.current++; setNewGoal(true); }} newGoal={newGoal}
    composer={<CloudComposer scope={props.scope} product={props.product} key={newGoal ? 'new' : observation.selectedRunId ?? 'empty'} observation={observation} newGoal={newGoal} pendingMessage={pendingMessage} canWrite={writable} value={newGoal ? goalDraft : observation.draft} onChange={value => newGoal ? setGoalDraft(value) : observer.setDraft(value)} onCancelNew={() => { selectionEpoch.current++; setNewGoal(false); }} onSubmit={async (payload) => {
      const submittedEpoch = selectionEpoch.current;
      const submittedText = Array.isArray(payload.parts) ? payload.parts.map(part => part && typeof part === 'object' && !Array.isArray(part) && part.kind === 'text' ? part.text : '').join('') : '';
      const result = await command('messages', payload);
      if (typeof payload.teamRunId === 'string') observer.acknowledgeDraft(payload.teamRunId, submittedText);
      // A direct HTTP receipt can arrive after a view change, just like lookup.
      // Clear only this submission's unchanged draft and keep the current run.
      if (selectionEpoch.current !== submittedEpoch) return;
      if (newGoal) setGoalDraft(current => current.trim() === submittedText ? '' : current);
      const runId = result.receipt?.teamRunId; if (typeof runId === 'string') chooseRun(runId);
    }} />}
    operations={<section className="team-cloud-operations" aria-label="操作记录"><header><strong>操作记录</strong><button className="team-text-button" type="button" disabled={!writable || queue.recovering} onClick={() => void operations?.recover()}>{queue.recovering ? '正在核对…' : '核对待确认操作'}</button></header>{queue.errorCode && <p role="alert">持久操作存储暂不可用（{queue.errorCode}）。</p>}{queue.operations.slice(-8).reverse().map(operation => <p key={operation.operationId} data-status={operation.status}><span>{operationLabel(operation.operation)}</span><span>{operationStatus[operation.status]}</span></p>)}{!queue.operations.length && <p className="team-muted">操作在发送前保存；刷新后继续核对。</p>}</section>}
    error={error} renderTasks={task => <CloudTask key={`${task.taskId}:${task.revision}`} task={task} scope={props.scope} product={props.product} canWrite={writable} command={command} />}
    effects={props.effectsEnabled && observation.selectedRunId ? <CloudEffectsPanel key={`${workspaceClientScopeKey(props.scope)}:${observation.selectedRunId}`} scope={props.scope} teamRunId={observation.selectedRunId} product={props.product} canWrite={writable} command={command} refreshKey={`${observation.projection?.snapshot.watermark ?? 0}:${queue.operations.map(row => `${row.operationId}:${row.status}`).join('|')}`} pendingEffectKeys={queue.operations.filter(row => !['confirmed', 'rejected'].includes(row.status)).map(row => /^groups\/[^/]+\/effects\/([^/]+)\/reconcile$/.exec(row.operation)?.[1]).filter((value): value is string => Boolean(value))} /> : undefined}
    renderInteraction={interaction => <CloudInteraction key={`${workspaceInteractionKey(interaction)}:${interaction.revision}`} summary={interaction} scope={props.scope} product={props.product} canWrite={writable} command={command} />}
    artifactUrl={(id, teamRunId) => props.product.artifactUrl(props.scope, id, teamRunId)}
    onControl={(action) => { const run = observation.projection?.snapshot.selectedRun; if (run) void command(`team-runs/${run.teamRunId}/control`, { action, expectedRevision: run.revision }).catch(cause => setError(cause instanceof Error ? cause.message : '操作失败。')); }}
    onAcceptance={(action, reason) => { const run = observation.projection?.snapshot.selectedRun; if (run) void command(`team-runs/${run.teamRunId}/acceptance`, { action, expectedRevision: run.revision, ...(reason ? { reason } : {}) }).catch(cause => setError(cause instanceof Error ? cause.message : '操作失败。')); }} />;
}

export interface CloudTeamWorkspaceViewProps {
  observation: WorkspaceObservation; canWrite: boolean; readOnlyReason?: string; error?: string; newGoal?: boolean;
  onRetry: () => void; onLoadMore: (collection: WorkspaceCollection) => void; onChooseRun: (id: string) => void; onNewGoal: () => void;
  composer?: React.ReactNode; operations?: React.ReactNode; effects?: React.ReactNode;
  renderTasks?: (task: WorkspaceTaskSummary) => React.ReactNode; renderInteraction?: (interaction: WorkspaceInteraction) => React.ReactNode;
  artifactUrl?: (id: string, teamRunId: string) => string; onControl?: (action: string) => void; onAcceptance?: (action: string, reason?: string) => void;
}
export function CloudTeamWorkspaceView(props: CloudTeamWorkspaceViewProps) {
  const { observation, canWrite, onLoadMore } = props;
  const snapshot = observation.projection?.snapshot;
  const [tab, setTab] = useState<'messages' | 'tasks' | 'artifacts' | 'approvals' | 'members' | 'effects'>('messages');
  const [reason, setReason] = useState('');
  const tabId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollPosition = useRef<{ context: string; bottom: boolean; anchorId?: string; anchorOffset?: number } | null>(null);
  const scrollContext = `${snapshot?.selectedRun?.teamRunId ?? ''}:${tab}:${Boolean(props.newGoal)}`;
  const captureScroll = () => {
    const panel = panelRef.current;
    if (!panel || tab !== 'messages') return;
    const panelTop = panel.getBoundingClientRect().top;
    const anchor = Array.from(panel.querySelectorAll<HTMLElement>('[data-message-id]')).find(row => row.getBoundingClientRect().bottom > panelTop);
    scrollPosition.current = { context: scrollContext, bottom: panel.scrollHeight - panel.clientHeight - panel.scrollTop < 48, anchorId: anchor?.dataset.messageId, anchorOffset: anchor ? anchor.getBoundingClientRect().top - panelTop : undefined };
  };
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel || tab !== 'messages') { scrollPosition.current = null; return; }
    const previous = scrollPosition.current;
    if (!previous || previous.context !== scrollContext || previous.bottom) panel.scrollTop = panel.scrollHeight;
    else if (previous.anchorId && previous.anchorOffset !== undefined) {
      const anchor = Array.from(panel.querySelectorAll<HTMLElement>('[data-message-id]')).find(row => row.dataset.messageId === previous.anchorId);
      // Preserve the visible message across history prepends and snapshot refreshes.
      // A reader who has scrolled up must not be pulled to the newest SSE message.
      if (anchor) panel.scrollTop += anchor.getBoundingClientRect().top - panel.getBoundingClientRect().top - previous.anchorOffset;
    }
    captureScroll();
  }, [scrollContext, snapshot?.recentMessages]); // eslint-disable-line react-hooks/exhaustive-deps
  const more = (collection: WorkspaceCollection, label = '加载更多') => snapshot?.cursors[collection] && <button className="team-button team-history-more" type="button" disabled={observation.loadingPages.includes(collection) || observation.connection !== 'connected'} onClick={() => onLoadMore(collection)}>{observation.loadingPages.includes(collection) ? '正在读取…' : label}</button>;
  if (!snapshot) return <section className="ksadk-teams team-workspace"><div className="team-empty"><h2>{observation.connection === 'offline' ? '暂时无法读取团队' : '正在打开工作区'}</h2><p role="status">{connectionText[observation.connection]}</p>{observation.errorCode && <p role="alert">{observation.errorCode}</p>}<button type="button" className="team-button" onClick={props.onRetry}>重新连接</button></div></section>;
  const run = snapshot.selectedRun;
  const members = run ? snapshot.selectedRunMembers : snapshot.members;
  return <section className="ksadk-teams team-workspace team-cloud-workspace" aria-label="云端团队工作区">
    <header className="team-header"><div><span className="team-eyebrow">云端协作空间</span><h1>{snapshot.group.name}</h1></div><div className="team-header-actions"><span className="team-connection" role="status">{connectionText[observation.connection]}</span><button type="button" className="team-button" onClick={props.onRetry}>刷新</button></div></header>
    {!canWrite && <p className="team-cloud-notice" role="status">只读 · {props.readOnlyReason || (observation.connection === 'connected' ? '服务暂未开放写入，已有历史仍可查看。' : '等待连接恢复后再提交操作。')}</p>}
    {props.error && <p role="alert" className="team-inline-error team-cloud-notice">{props.error}</p>}
    <div className="team-cloud-layout"><aside className="team-cloud-runs" aria-label="团队任务"><header><h2>团队任务</h2><button className="team-text-button" type="button" disabled={!canWrite} onClick={props.onNewGoal}>新任务</button></header>
      {snapshot.runSummaries.map(item => <button type="button" className="team-cloud-run" key={item.teamRunId} aria-current={!props.newGoal && run?.teamRunId === item.teamRunId ? 'page' : undefined} onClick={() => props.onChooseRun(item.teamRunId)}><strong>{item.goal}</strong><span><TeamStatusLabel status={item.status} /> · {item.taskCount} 项任务</span>{item.pendingCount > 0 && <small>{item.pendingCount} 项待处理</small>}</button>)}
      {!snapshot.runSummaries.length && <p className="team-muted">还没有协作任务。从一个目标开始。</p>}{more('runSummaries', '更多团队任务')}{props.operations}</aside>
      <div className="team-cloud-main">{props.newGoal ? <div className="team-cloud-goal"><span className="team-eyebrow">新的协作任务</span><h2>这次需要团队完成什么？</h2><p>描述目标和交付要求。任务记录与其他协作独立保存。</p></div> : <>
        {run && <header className="team-cloud-run-header"><h2>{run.goal}</h2><div className="team-task-actions"><TeamStatusLabel status={run.status} />{run.dispatchSuspended && <span>已暂停派发</span>}{isTeamRunActive(run.status) && run.status !== 'cancel_requested' && props.onControl && <><button className="team-button" type="button" disabled={!canWrite} onClick={() => props.onControl?.(run.dispatchSuspended ? 'resume_dispatch' : 'suspend_dispatch')}>{run.dispatchSuspended ? '恢复派发' : '暂停派发'}</button><button className="team-button team-danger" type="button" disabled={!canWrite} onClick={() => props.onControl?.('stop')}>停止任务</button></>}</div>{run.reason && <p className="team-muted">{executionReason(run.reason)}</p>}
          {run.status === 'awaiting_acceptance' && props.onAcceptance && <div className="team-cloud-acceptance"><p>请查看成果后验收。</p><label className="team-field">修改意见<textarea rows={2} value={reason} maxLength={2000} onChange={event => setReason(event.target.value)} disabled={!canWrite} /></label><button className="team-button" disabled={!canWrite || !reason.trim()} onClick={() => props.onAcceptance?.('request_changes', reason.trim())}>提出修改</button><button className="team-button team-primary" disabled={!canWrite} onClick={() => props.onAcceptance?.('accept')}>验收通过</button></div>}
          {run.leaderStandby && <CloudLeaderStandby value={run.leaderStandby} />}
        </header>}
        <div className="team-cloud-tabs" role="tablist" aria-label="任务工作区">{(['messages', 'tasks', 'artifacts', 'approvals', 'members', 'effects'] as const).filter(value => value !== 'effects' || props.effects).map(value => <button type="button" role="tab" id={`${tabId}-${value}`} aria-controls={`${tabId}-panel`} aria-selected={tab === value} key={value} onClick={() => setTab(value)}>{({ messages: '消息', tasks: '任务', artifacts: '交付物', approvals: '待处理', members: '成员', effects: '执行核查' })[value]}{value === 'approvals' && run?.pendingCount ? ` (${run.pendingCount})` : ''}</button>)}</div>
        <div ref={panelRef} onScroll={captureScroll} className="team-cloud-panel" role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${tab}`} tabIndex={0}>
          {tab === 'effects' && props.effects}
          {tab === 'messages' && <>{more('recentMessages', '查看更早的消息')}{snapshot.recentMessages.filter(message => message.visibility === 'public').map(message => <article className="team-message" key={message.messageId} data-message-id={message.messageId} data-role={message.groupRole}><div className="team-message-main"><header><strong>{message.senderName}</strong><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></header><div className="team-message-body">{message.parts.map((part, index) => part.kind === 'text' ? <MessageMarkdown key={index} content={part.text} /> : <span className="team-attachment" key={index}>{part.name || '附件'}</span>)}</div></div></article>)}{!snapshot.recentMessages.length && <p className="team-muted">{run ? '这项协作还没有公开消息。' : '选择任务查看消息，或新建协作目标。'}</p>}</>}
          {tab === 'tasks' && <>{snapshot.taskSummaries.map(task => props.renderTasks?.(task) ?? <article key={task.taskId}><h3>{task.title}</h3><TeamStatusLabel status={task.status} /></article>)}{!snapshot.taskSummaries.length && <p className="team-muted">尚无分工任务。</p>}{more('taskSummaries')}</>}
          {tab === 'approvals' && <>{snapshot.pendingInteractions.map(interaction => props.renderInteraction?.(interaction) ?? <p key={workspaceInteractionKey(interaction)}>{interaction.title}</p>)}{!snapshot.pendingInteractions.length && <p className="team-muted">当前任务没有待处理事项。</p>}{more('pendingInteractions')}</>}
          {tab === 'artifacts' && <>{snapshot.artifactSummaries.map(artifact => <article className="team-cloud-artifact" key={artifact.artifactId}><div><strong>{artifact.name}</strong><p className="team-muted">{artifact.mediaType} · {artifact.sizeBytes.toLocaleString()} 字节 · {artifact.state === 'ready' ? '已就绪' : artifact.state === 'failed' ? '准备失败' : '准备中'}</p></div>{artifact.state === 'ready' && props.artifactUrl && <a href={props.artifactUrl(artifact.artifactId, artifact.teamRunId)} download={artifact.name}>下载</a>}</article>)}{!snapshot.artifactSummaries.length && <p className="team-muted">交付物准备好后会显示在这里。</p>}{more('artifactSummaries')}</>}
          {tab === 'members' && <>{members.map(member => <article className="team-cloud-member" key={member.memberId}><div><strong>{member.name}</strong><span className="team-muted"> {member.role === 'leader' ? 'Leader' : '成员'} · {member.binding.kind === 'local_build' ? '本地节点' : '云端节点'}</span><p>{member.responsibility}</p><p className="team-muted">{member.binding.availability.state === 'ready' ? '执行环境就绪' : member.binding.availability.state === 'unchecked' ? '执行环境待检查' : '执行环境不可用'} · {executionText[member.executionStatus]}</p>{(member.reason || member.binding.availability.reason) && <p role="status">{member.reason || member.binding.availability.reason}</p>}</div></article>)}<p className="team-muted">节点环境与执行状态来自最近同步；离开页面只停止观察。</p></>}
        </div></>}{props.composer}</div></div>
  </section>;
}

function CloudComposer({ scope, product, observation, newGoal, pendingMessage, value, onChange, canWrite, onSubmit, onCancelNew }: { scope: WorkspaceClientScope; product: HttpCloudTeamsProductClient; observation: WorkspaceObservation; newGoal: boolean; pendingMessage: boolean; value: string; onChange: (value: string) => void; canWrite: boolean; onSubmit: (payload: TeamsOperationPayload) => Promise<void>; onCancelNew: () => void }) {
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const isImeComposing = useImeComposition();
  const [upload] = useState(() => new CloudMaterialUpload(product, scope));
  const material = useSyncExternalStore(upload.subscribe, upload.getSnapshot, upload.getSnapshot);
  useEffect(() => () => upload.dispose(), [upload]);
  useEffect(() => { if (!canWrite) upload.cancel(); }, [canWrite, upload]);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const snapshot = observation.projection?.snapshot; const run = newGoal ? null : snapshot?.selectedRun;
  const starting = newGoal || !run;
  const writable = canWrite && !pendingMessage && (starting || (isTeamRunActive(run!.status) && run!.status !== 'cancel_requested'));
  const materialReady = !starting || material.files.length === 0 || material.state === 'ready';
  const uploading = materialIsBusy(material.state);
  async function send() {
    if (!writable || busy || !value.trim() || !materialReady) return;
    setBusy(true); setError('');
    try {
      await onSubmit({ parts: [{ kind: 'text', text: value.trim() }], mentions: starting || !target ? [] : [target], intent: starting ? 'start_goal' : target ? 'directed' : 'followup', ...(!starting ? { teamRunId: run!.teamRunId } : {}), ...(starting && material.material?.state === 'ready' ? { materialManifestRef: material.material.materialId } : {}) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : '提交未完成，草稿已保留。'); } finally { setBusy(false); }
  }
  const uploadStatus = { idle: '', hashing: '正在校验文件', creating: '正在准备上传', uploading: '正在上传', verifying: '服务端正在校验', ready: '材料已就绪', failed: '上传未完成', cancelled: '上传已取消' };
  return <form className="team-composer-wrap" onSubmit={event => { event.preventDefault(); void send(); }}>
    {pendingMessage && <p className="team-cloud-notice" role="status">上一条消息的接收结果未确认，请先在操作记录中核对原单。</p>}
    {error && <p className="team-inline-error" role="alert">{error}</p>}
    <div className="team-composer">
      <label className="team-sr-only" htmlFor={id}>{starting ? '团队协作目标' : '给团队的消息'}</label>
      <textarea id={id} rows={3} value={value} onChange={event => onChange(event.target.value)} disabled={busy} placeholder={starting ? '描述目标、预期成果和约束…' : run && !isTeamRunActive(run.status) ? '此任务已结束，可新建任务继续协作' : !canWrite ? '可先整理草稿，恢复连接后再发送…' : '补充要求，或向成员提问…'} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !isImeComposing(event)) { event.preventDefault(); void send(); } }} />
      {starting && material.files.length > 0 && <section className="team-cloud-materials" aria-label="任务材料">
        <div className="team-cloud-material-status"><span role="status">{uploadStatus[material.state]}{uploading ? ` · ${material.completed}/${material.files.length}` : ''}</span><span>{material.files.length} 个文件</span></div>
        <ul>{material.files.map((file, index) => <li key={`${index}:${file.name}`}><span>{file.name}</span><span>{file.size.toLocaleString()} 字节</span></li>)}</ul>
        {material.error && <p className="team-inline-error" role="alert">{material.error}</p>}
        <div className="team-task-actions">
          {uploading && <button type="button" className="team-text-button" onClick={() => upload.cancel()}>取消上传</button>}
          {['failed', 'cancelled'].includes(material.state) && <button type="button" className="team-text-button" disabled={!writable || busy} onClick={() => void upload.retry()}>重试上传</button>}
          <button type="button" className="team-text-button" disabled={busy || pendingMessage} onClick={() => upload.clear()}>移除材料</button>
        </div>
      </section>}
      <div className="team-composer-toolbar"><div>
        {!starting && <select aria-label="接收成员" value={target} onChange={event => setTarget(event.target.value)} disabled={busy || !writable}><option value="">发给 Leader</option>{snapshot?.selectedRunMembers.filter(member => member.status === 'active').map(member => <option key={member.memberId} value={member.memberId}>@{member.name}</option>)}</select>}
        {starting && <><input ref={fileInput} type="file" multiple hidden aria-label="选择任务材料" onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (writable && !busy && files.length) void upload.select(files); }} /><button className="team-text-button" type="button" disabled={!writable || busy || uploading} onClick={() => fileInput.current?.click()}>{material.files.length ? '重新选择材料' : '添加材料'}</button></>}
        {newGoal && <button className="team-text-button" type="button" disabled={busy || pendingMessage} onClick={onCancelNew}>返回任务</button>}
      </div><button className="team-button team-primary" type="submit" disabled={!writable || busy || !value.trim() || !materialReady}>{busy ? '正在核对' : starting ? '开始协作' : '发送'}</button></div>
    </div>
    <p className="team-composer-help">Enter 发送 · Shift + Enter 换行{starting ? ' · 单个材料 ≤20 MiB，总计 ≤64 MiB' : ' · 接收回执不代表执行完成'}</p>
  </form>;
}

function CloudTask({ task, scope, product, canWrite, command }: { task: WorkspaceTaskSummary; scope: WorkspaceClientScope; product: HttpCloudTeamsProductClient; canWrite: boolean; command: (suffix: string, payload: TeamsOperationPayload) => Promise<unknown> }) {
  const [open, setOpen] = useState(false); const [detail, setDetail] = useState<TeamTask | null>(null); const [error, setError] = useState('');
  useEffect(() => { if (!open) return; const controller = new AbortController(); void product.task(scope, task.taskId, task.teamRunId, controller.signal).then(value => { if (!controller.signal.aborted) { if (value.taskId !== task.taskId || value.revision !== task.revision) throw new Error('任务已更新，请刷新后重试。'); setDetail(value); } }).catch(() => { if (!controller.signal.aborted) setError('任务详情读取失败，请关闭后重新打开。'); }); return () => controller.abort(); }, [open, product, scope, task]);
  return <article className="team-cloud-task"><button className="team-cloud-task-title" type="button" aria-expanded={open} onClick={() => { setOpen(!open); setError(''); }}><strong>{task.title}</strong><TeamStatusLabel status={task.status} /></button>{task.reason && <p className="team-muted">{executionReason(task.reason)}</p>}{open && (detail ? <TaskDetail task={detail} members={[]} onAction={canWrite ? (_task, action, reason) => command(`tasks/${task.taskId}/actions`, { action, expectedRevision: task.revision, ...(reason ? { reason } : {}) }) : undefined} /> : <p role={error ? 'alert' : 'status'}>{error || '正在读取任务详情…'}</p>)}</article>;
}
function secretSchema(value: unknown): boolean { if (!value || typeof value !== 'object') return false; if (Array.isArray(value)) return value.some(secretSchema); const row = value as Record<string, unknown>; return row.secret === true || row.writeOnly === true || row.format === 'password' || Object.values(row).some(secretSchema); }
function CloudInteraction({ summary, scope, product, canWrite, command }: { summary: WorkspaceInteraction; scope: WorkspaceClientScope; product: HttpCloudTeamsProductClient; canWrite: boolean; command: (suffix: string, payload: TeamsOperationPayload) => Promise<unknown> }) {
  const [detail, setDetail] = useState<CloudInteractionDetail | null>(null); const [open, setOpen] = useState(false); const [values, setValues] = useState<Record<string, unknown>>({}); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [submitted, setSubmitted] = useState(false);
  useEffect(() => { if (!open) return; const controller = new AbortController(); void product.interaction(scope, summary, controller.signal).then(value => { if (!controller.signal.aborted) setDetail(value); }).catch(() => { if (!controller.signal.aborted) setError('审批详情读取失败，请关闭后重试或刷新。'); }); return () => controller.abort(); }, [open, scope, product, summary]);
  async function respond(action: string, response: Record<string, unknown>) { if (!canWrite || !detail || detail.status !== 'pending' || busy || submitted || secretSchema(detail.requestSchema)) return; setBusy(true); setError(''); try { await command('interactions', { ref: detail.ref, expectedRevision: detail.revision, action, response: response as TeamsOperationPayload }); setSubmitted(true); } catch (cause) { setError(cause instanceof Error ? cause.message : '审批提交失败。'); } finally { setBusy(false); } }
  return <article className="team-interaction-card"><h3>{summary.title}</h3><button className="team-text-button" type="button" aria-expanded={open} onClick={() => { setOpen(!open); setError(''); }}>{open ? '收起详情' : '查看并处理'}</button>{open && (!detail ? <p role="status">{error || '正在读取审批详情…'}</p> : <><InteractionMessage message={detail.message} />{submitted || detail.status !== 'pending' ? <p role="status">{submitted || detail.status === 'resolving' ? '服务端已接收，等待执行端确认。' : detail.status === 'expired' ? '该事项已过期。' : detail.status === 'cancelled' ? '该事项已取消。' : '该事项已处理。'}</p> : secretSchema(detail.requestSchema) ? <p role="status">此表单包含敏感字段，无法通过浏览器持久队列提交，请使用安全凭据配置入口。</p> : detail.kind === 'input' ? detail.requestSchema && schemaFields(detail.requestSchema).length > 0 ? <InteractionSchemaForm schema={detail.requestSchema} values={values} onChange={setValues} disabled={!canWrite || busy} onSubmit={() => void respond('submit', values)} onCancel={() => void respond('cancel', {})} /> : <p role="status">缺少输入表单，暂不能提交。</p> : <div className="team-task-actions"><button className="team-button" disabled={!canWrite || busy} onClick={() => void respond('reject', { approved: false })}>拒绝</button><button className="team-button team-primary" disabled={!canWrite || busy} onClick={() => void respond('approve', { approved: true })}>同意</button></div>}</>)}{error && detail && <p role="alert" className="team-inline-error">{error}</p>}</article>;
}
