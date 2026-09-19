import { lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { InteractionMessage } from './InteractionMessage.js';
import { TeamReconciliation, type ReconciliationActions } from './TeamReconciliation.js';
import { MessageMarkdown } from '../MessageMarkdown.js';
import { InteractionSchemaForm } from '../chat/InteractionSchemaForm.js';
import { currentTeamRun, isTeamRunActive, safeArtifactUri, taskDisplayReason, taskSection, TEAM_STATUS_LABELS } from '../../core/teams/presentation.js';
import { interactionRefKey } from '../../core/teams/reducer.js';
import type { AgentMember, ConnectionStatus, GroupMessage, GroupMessageInput, GroupReceipt, GroupSnapshot, MemberObservation, TaskAction, TeamArtifact, TeamControlAction, TeamInteraction, TeamInteractionInput, TeamRun, TeamTask, ExecutionNode, ExecutionSnapshot, MemberStreamRef, GroupMessagePart, ExecutionBinding, LeaderStandbyConfiguration } from '../../core/teams/types.js';

const LazyExecutionTree = lazy(() => import('./ExecutionTree.js').then(module => ({ default: module.ExecutionTree })));
const key = () => `team-${globalThis.crypto.randomUUID()}`;
const roles = { owner: '群主', leader: 'Leader', member: '成员', system: '系统' };
const memberStatus = { idle: '空闲', queued: '待执行', running: '进行中', waiting: '等待中', needs_attention: '需要处理', unavailable: '不可用' };
const connectionLabel: Record<ConnectionStatus, string> = { connecting: '正在连接', connected: '已连接', reconnecting: '正在重连 · 任务继续执行', offline: '连接中断 · 显示最后状态', closed: '未连接' };

function Initial({ name }: { name: string }) { return <span className="team-avatar" aria-hidden="true">{Array.from(name.trim())[0] || 'A'}</span>; }
export function TeamStatusLabel({ status }: { status: string }) { return <span className="team-status" data-status={status}>{TEAM_STATUS_LABELS[status as keyof typeof TEAM_STATUS_LABELS] ?? status}</span>; }

function RunGoal({ goal }: { goal: string }) {
  if (goal.length <= 100) return <h3>{goal}</h3>;
  return <details className="team-run-goal"><summary><h3>{goal}</h3><span>完整目标</span></summary><p>{goal}</p></details>;
}

export function GroupHeader({ snapshot, connection, onMembers, onManage }: { snapshot: GroupSnapshot; connection: ConnectionStatus; onProgress: () => void; onMembers: () => void; onManage?: () => void }) {
  const active = snapshot.members.filter(member => member.status !== 'removed');
  return <header className="team-header">
    <div className="team-header-identity"><div className="team-avatar-stack" aria-hidden="true">{active.slice(0, 3).map(member => <Initial key={member.memberId} name={member.name} />)}</div><div><h1>{snapshot.group.name}</h1><button type="button" className="team-text-button team-muted" onClick={onMembers}>{active.length} 位成员 · {active.find(member => member.memberId === snapshot.group.leaderMemberId)?.name || 'Leader'}</button></div></div>
    <div className="team-header-actions">{connection !== 'connected' && <span className="team-connection" role="status">{connectionLabel[connection]}</span>}{onManage && <button type="button" className="team-button" onClick={onManage}>设置</button>}</div>
  </header>;
}

export function GroupTimeline({ messages, children, emptyState, focusFinalDelivery }: { messages: GroupMessage[]; children?: ReactNode; emptyState?: ReactNode; focusFinalDelivery?: string }) {
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [limit, setLimit] = useState(100);
  const visible = messages.filter(message => message.visibility === 'public');
  const scrollSignal = visible.map(message => `${message.messageId}:${message.revision}`).join('|');
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!follow.current || !element) return;
    const delivery = focusFinalDelivery ? element.querySelector('.team-final-delivery') : null;
    if (delivery) element.scrollTop += delivery.getBoundingClientRect().top - element.getBoundingClientRect().top - 12;
    else element.scrollTop = element.scrollHeight;
  }, [scrollSignal, focusFinalDelivery]);
  function loadMore() {
    const element = scroll.current;
    if (!element) return;
    const height = element.scrollHeight;
    setLimit(value => value + 100);
    requestAnimationFrame(() => { element.scrollTop += element.scrollHeight - height; });
  }
  return <div className="team-timeline" ref={scroll} onScroll={() => { const element = scroll.current; if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }} aria-label="群聊消息" tabIndex={0}>
    <div className="team-timeline-inner">
      {visible.length > limit && <button className="team-button team-history-more" type="button" onClick={loadMore}>查看更早的消息</button>}
      {!visible.length && (emptyState ?? <div className="team-empty"><span className="team-eyebrow">一起完成一个目标</span><h2>团队已就绪</h2><p>描述你想得到的成果，Leader 会组织成员分工。<br />也可以 @成员，指定由谁参与。</p></div>)}
      {visible.slice(-limit).map(message => <article key={message.messageId} className="team-message" data-role={message.groupRole} data-message-id={message.messageId}>
        {message.groupRole !== 'owner' && <Initial name={message.senderName} />}
        <div className="team-message-main"><header><strong>{message.senderName}</strong><span>{roles[message.groupRole]}</span><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>{message.intent === 'note' && <span>仅留言</span>}</header><div className="team-message-body">{message.parts.map((part, index) => part.kind === 'text' ? <MessageMarkdown key={index} content={part.text} /> : <span className="team-attachment" key={part.attachmentRef}>{part.name || '附件'} <span>{part.mediaType}</span></span>)}</div></div>
      </article>)}
      {children}
    </div>
  </div>;
}

export function TeamProgressCard({ run, tasks, pendingCount, onOpen, compact = false }: { run: TeamRun; tasks: TeamTask[]; pendingCount: number; onOpen: () => void; compact?: boolean }) {
  const accepted = tasks.filter(task => task.status === 'succeeded').length;
  const active = isTeamRunActive(run.status);
  return <button type="button" className="team-progress-card" data-active={active || undefined} onClick={onOpen} aria-label={`查看协作：${run.goal}`}>
    <span className="team-progress-heading"><span className="team-eyebrow">本轮协作</span><span className="team-progress-status"><TeamStatusLabel status={run.status} />{active && <span className="team-progress-live" role="status">实时处理中<span aria-hidden="true"><i /><i /><i /></span></span>}</span></span>
    {!compact && <strong>{run.goal}</strong>}<span className="team-progress-caption">{tasks.length ? `${accepted} / ${tasks.length} 项任务已验收` : '正在整理目标与分工'}{pendingCount > 0 ? ` · ${pendingCount} 项需要处理` : ''}<span>查看协作 <span aria-hidden="true">→</span></span></span>
    {run.reason && <span className="team-progress-reason">{run.reason}</span>}
  </button>;
}

export function GroupComposer({ members, activeRun, value, onChange, onSend, disabled = false, recipientMemberId, onRecipientChange, focusRequest = 0, artifacts = [], referenceArtifacts = [], serverAuthority = false }: { members: AgentMember[]; activeRun: TeamRun | null; value: string; onChange: (value: string) => void; onSend: (input: GroupMessageInput) => Promise<unknown>; disabled?: boolean; recipientMemberId?: string; onRecipientChange?: (memberId: string) => void; focusRequest?: number; artifacts?: TeamArtifact[]; referenceArtifacts?: TeamArtifact[]; serverAuthority?: boolean }) {
  const inputId = useId();
  const recipientId = useId();
  const artifactId = useId();
  const scope = activeRun?.teamRunId || '';
  type Options = { attachmentIds: string[]; note: boolean; sourcePath: string; baseRef: string; inputs: string; mode: 'auto' | 'directory' };
  const emptyOptions: Options = { attachmentIds: [], note: false, sourcePath: '', baseRef: '', inputs: '', mode: 'auto' };
  const [optionsByTask, setOptionsByTask] = useState<Record<string, Options>>({});
  const options = optionsByTask[scope] || emptyOptions;
  const updateOptions = (patch: Partial<Options>) => setOptionsByTask(rows => ({ ...rows, [scope]: { ...(rows[scope] || emptyOptions), ...patch } }));
  const { attachmentIds, note } = options;
  const setAttachmentIds = (action: string[] | ((ids: string[]) => string[])) => setOptionsByTask(rows => { const previous = rows[scope] || emptyOptions; return { ...rows, [scope]: { ...previous, attachmentIds: typeof action === 'function' ? action(previous.attachmentIds) : action } }; });
  const setNote = (value: boolean) => updateOptions({ note: value });
  const allArtifacts = [...new Map([...artifacts, ...referenceArtifacts].map(artifact => [artifact.artifactId, artifact])).values()];
  const attachments = allArtifacts.filter(artifact => attachmentIds.includes(artifact.artifactId));
  const [localTarget, setLocalTarget] = useState('');
  const target = recipientMemberId ?? localTarget;
  const setTarget = (value: string) => { setLocalTarget(value); onRecipientChange?.(value); };
  const textarea = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 176)}px`;
  }, [value]);
  useEffect(() => { if (focusRequest) textarea.current?.focus(); }, [focusRequest]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  useEffect(() => { setError(''); }, [scope]);
  const [sending, setSending] = useState(false);
  const hasActiveRun = Boolean(activeRun && isTeamRunActive(activeRun.status));
  const completedRun = Boolean(activeRun && !hasActiveRun);
  const directedUnavailable = (completedRun || activeRun?.status === 'cancel_requested') && !note;
  const [error, setError] = useState('');
  const pending = useRef(new Map<string, { digest: string; idempotencyKey: string }>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const mentionQuery = /@([^\s@]*)$/u.exec(value)?.[1];
  const mentionOptions = mentionQuery !== undefined ? members.filter(member => member.status === 'active' && member.name.toLowerCase().includes(mentionQuery.toLowerCase())) : [];
  async function submit() {
    if (disabled || sending || (!value.trim() && !attachments.length)) return;
    if (directedUnavailable) { setError('这个任务已结束，请新建任务继续协作。'); return; }
    const text = value.trim();
    const intent = note ? 'note' : !activeRun ? 'start_goal' : target !== '' ? 'directed' : 'followup';
    if (intent === 'start_goal' && !text) { setError('请补充这轮希望团队完成的目标，或选择仅留言。'); return; }
    const mentions = target === '' ? [] : [target];
    const parts: GroupMessagePart[] = [...(text ? [{ kind: 'text' as const, text }] : []), ...attachments.map(artifact => ({ kind: 'attachment' as const, attachmentRef: artifact.artifactId, mediaType: artifact.mediaType, name: artifact.name }))];
    const teamRunId = activeRun?.teamRunId;
    const requestScope = scope;
    if (intent === 'start_goal' && !options.sourcePath.trim() && (options.baseRef.trim() || options.inputs.trim())) { setError('请先填写执行节点上的工作目录。'); return; }
    const workspace = intent === 'start_goal' && options.sourcePath.trim() ? { sourcePath: options.sourcePath.trim(), mode: options.mode, ...(options.mode === 'auto' && options.baseRef.trim() ? { baseRef: options.baseRef.trim() } : {}), inputs: options.inputs.split(/\r?\n/).map(path => path.trim()).filter(Boolean) } : undefined;
    if (workspace && serverAuthority && workspace.mode === 'auto' && !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(options.baseRef.trim())) { setError('云端协作的 Git 基线需要完整的 40 或 64 位 commit，请在工作目录设置中填写。'); return; }
    if (workspace && workspace.inputs.length > 32) { setError('每次任务最多引用 32 个输入文件。'); return; }
    const digest = JSON.stringify([parts, intent, mentions, teamRunId, workspace]);
    if (pending.current.get(scope)?.digest !== digest) pending.current.set(scope, { digest, idempotencyKey: key() });
    const request = pending.current.get(scope)!;
    setSending(true); setError('');
    try {
      const receipt = await onSend({ parts, mentions, intent, ...(teamRunId ? { teamRunId } : {}), ...(workspace ? { workspace } : {}), idempotencyKey: request.idempotencyKey }) as GroupReceipt | undefined;
      if (!mounted.current) return;
      if (receipt?.status === 'rejected' || receipt?.status === 'uncertain') throw new Error(receipt.reason || (receipt.status === 'uncertain' ? '消息接收结果尚未确认。再次提交将使用相同标识核对。' : '消息未被接收。'));
      if (currentScope.current === requestScope) { onChange(''); setAttachmentIds([]); } pending.current.delete(requestScope);
      if (intent === 'start_goal') setOptionsByTask(rows => { const next = { ...rows }; delete next[requestScope]; return next; });
    } catch (cause) { setError(cause instanceof Error ? cause.message : '消息发送失败，请重试。'); }
    finally { setSending(false); }
  }
  function chooseMention(member: AgentMember) { setTarget(member.memberId); onChange(value.replace(/@([^\s@]*)$/u, `@${member.name} `)); setMentionIndex(0); textarea.current?.focus(); }
  return <form className="team-composer-wrap" onSubmit={event => { event.preventDefault(); void submit(); }}>
    {error && <p className="team-inline-error" role="alert">{error}</p>}
    {!!mentionOptions.length && <div className="team-mention-options" role="listbox" aria-label="选择要提及的成员">{mentionOptions.map((member, index) => <button type="button" role="option" aria-selected={index === mentionIndex} key={member.memberId} onClick={() => chooseMention(member)}><Initial name={member.name} /><span>{member.name}</span><small>{member.role === 'leader' ? 'Leader' : '成员'}</small></button>)}</div>}
    {!!attachments.length && <div className="team-selected-artifacts" aria-label="已选择的交付物">{attachments.map(artifact => <span className="team-attachment" key={artifact.artifactId}>{artifact.name}<button type="button" className="team-text-button" aria-label={`移除引用 ${artifact.name}`} disabled={sending} onClick={() => setAttachmentIds(ids => ids.filter(id => id !== artifact.artifactId))}>×</button></span>)}</div>}
    <div className="team-composer"><label className="team-sr-only" htmlFor={inputId}>给团队的消息</label><textarea ref={textarea} id={inputId} value={value} rows={2} onChange={event => { onChange(event.target.value); setMentionIndex(0); }} placeholder={note ? '留下一条消息，不启动任务…' : target === '' ? '描述目标、交付物或需要团队解决的问题…' : '向选中的成员提问或分派工作…'} disabled={disabled || sending} onKeyDown={event => { if (mentionOptions.length && !event.nativeEvent.isComposing && ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) { event.preventDefault(); if (event.key === 'Enter') chooseMention(mentionOptions[mentionIndex % mentionOptions.length]); else setMentionIndex(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + mentionOptions.length) % mentionOptions.length); return; } if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
      <div className="team-composer-toolbar"><div><label className="team-sr-only" htmlFor={recipientId}>接收成员</label><select id={recipientId} value={target} onChange={event => setTarget(event.target.value)} disabled={disabled || sending}><option value="">发给 Leader</option>{members.filter(member => member.status === 'active').map(member => <option key={member.memberId} value={member.memberId}>@{member.name}</option>)}</select><details className="team-composer-more"><summary aria-label="更多消息选项">···</summary><div className="team-composer-menu"><label className="team-note-toggle"><input type="checkbox" checked={note} onChange={event => setNote(event.target.checked)} disabled={disabled || sending} />仅留言，不启动执行</label>{!activeRun && <details className="team-workspace-options"><summary>工作目录{options.sourcePath ? ' · 已选择' : ' · 可选'}</summary><label className="team-field">工作目录<input value={options.sourcePath} maxLength={4096} onChange={event => updateOptions({ sourcePath: event.target.value })} placeholder="执行节点上的目录路径" disabled={sending} /></label><label className="team-field">目录类型<select value={options.mode} onChange={event => updateOptions({ mode: event.target.value as 'auto' | 'directory' })}><option value="auto">{serverAuthority ? 'Git 仓库' : '自动识别 Git'}</option><option value="directory">普通目录，仅复制输入文件</option></select></label>{options.mode === 'auto' && <label className="team-field">Git 基线<input value={options.baseRef} maxLength={256} onChange={event => updateOptions({ baseRef: event.target.value })} placeholder={serverAuthority ? "完整 commit（40 或 64 位）" : "HEAD"} disabled={sending} /></label>}<label className="team-field">输入文件<textarea rows={2} value={options.inputs} onChange={event => updateOptions({ inputs: event.target.value })} placeholder="每行一个相对路径（非 Git 目录）" disabled={sending} /></label><p>路径须在执行节点可访问。Git 使用提交版本，不带入未提交修改；普通目录只复制列出的输入文件。{serverAuthority && "云端协作需填写固定 commit，并确保节点可访问相同版本。"}</p></details>}</div></details>{!!allArtifacts.length && <><label className="team-sr-only" htmlFor={artifactId}>引用本群交付物</label><select id={artifactId} value="" disabled={disabled || sending || attachments.length >= 8} onChange={event => { const id = event.target.value; if (id) setAttachmentIds(ids => ids.includes(id) ? ids : [...ids, id]); }}><option value="">引用交付物</option><optgroup label="当前任务">{artifacts.filter(artifact => !attachmentIds.includes(artifact.artifactId)).map(artifact => <option key={artifact.artifactId} value={artifact.artifactId}>{artifact.name}</option>)}</optgroup><optgroup label="其他任务（显式引用）">{referenceArtifacts.filter(artifact => !artifacts.some(row => row.artifactId === artifact.artifactId) && !attachmentIds.includes(artifact.artifactId)).map(artifact => <option key={artifact.artifactId} value={artifact.artifactId}>{artifact.name}</option>)}</optgroup></select></>}</div><button className="team-button team-primary" type="submit" disabled={disabled || sending || directedUnavailable || (!value.trim() && !attachments.length)}>{sending ? '正在发送' : '发送'}</button></div>
    </div><p className="team-composer-help">{directedUnavailable ? activeRun?.status === 'cancel_requested' ? '正在停止任务 · 等待执行端确认' : '任务已结束 · 新建任务以继续协作' : <>Enter 发送 · Shift + Enter 换行{note ? ' · 留言不会唤醒成员' : ''}</>}</p>
  </form>;
}

export function TaskBoard({ tasks, members, selectedTaskId, onSelect }: { tasks: TeamTask[]; members: AgentMember[]; selectedTaskId?: string; onSelect: (task: TeamTask) => void }) {
  const sections = [['attention', '需处理'], ['running', '进行中'], ['waiting', '等待'], ['done', '已完成']] as const;
  if (!tasks.length) return <div className="team-panel-empty"><h3>尚未分派任务</h3><p>Leader 建立任务后，负责人、依赖与验收进度会出现在这里。</p></div>;
  return <div className="team-task-board">{sections.map(([id, label]) => {
    const rows = tasks.filter(task => taskSection(task) === id);
    return rows.length ? <section key={id}><h3>{label}<span>{rows.length}</span></h3>{rows.map(task => <button className="team-task-row" type="button" key={task.taskId} onClick={() => onSelect(task)} aria-pressed={selectedTaskId === task.taskId}><span className="team-task-row-main"><strong>{task.title}</strong><TeamStatusLabel status={task.status} /></span><span className="team-muted">{members.find(member => member.memberId === task.ownerMemberId)?.name || '待分派'}{taskDisplayReason(task) ? ` · ${taskDisplayReason(task)}` : task.dependencies.length && task.status === 'blocked' ? ' · 等待前置任务验收' : ''}</span></button>)}</section> : null;
  })}</div>;
}

function ArtifactLink({ artifact, onOpen }: { artifact: TeamArtifact; onOpen?: (artifact: TeamArtifact) => void }) {
  const href = safeArtifactUri(artifact.uri);
  return <div className="team-artifact">{onOpen ? <button className="team-text-button" type="button" onClick={() => onOpen(artifact)}>{artifact.name}</button> : href ? <a href={href} target="_blank" rel="noopener noreferrer">{artifact.name}</a> : <span>{artifact.name}</span>}<small>{artifact.mediaType}{artifact.digest ? ` · ${artifact.digest.slice(0, 12)}` : ''}</small></div>;
}

export function TaskDetail({ task, members, onAction, onOpenArtifact, onMemberSelect }: { task: TeamTask; members: AgentMember[]; onAction?: (task: TeamTask, action: TaskAction, reason?: string) => Promise<unknown>; onOpenArtifact?: (artifact: TeamArtifact) => void; onMemberSelect?: (member: AgentMember) => void }) {
  const [attemptId, setAttemptId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const attempt = task.attempts.find(row => row.attemptId === attemptId) ?? task.attempts.at(-1);
  const member = members.find(row => row.memberId === task.ownerMemberId);
  async function act(action: TaskAction) { if (!onAction || busy) return; if (action === 'reject' && !reason.trim()) { setError('请填写需要修改的内容。'); return; } setBusy(true); setError(''); try { await onAction(task, action, action === 'reject' ? reason.trim() : undefined); setRejecting(false); } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败。'); } finally { setBusy(false); } }
  return <section className="team-task-detail"><TeamStatusLabel status={task.status} /><h3>{task.title}</h3>{member && <button className="team-member-link" type="button" onClick={() => onMemberSelect?.(member)} disabled={!onMemberSelect}><Initial name={member.name} />{member.name}<span>查看执行</span></button>}<p>{task.description}</p>{taskDisplayReason(task) && <p className="team-detail-reason">{taskDisplayReason(task)}</p>}
    <h4>验收要求</h4><p>{task.acceptanceCriteria || '等待确定验收要求'}</p>
    {task.attempts.length > 1 && <label className="team-field">执行记录<select value={attempt?.attemptId} onChange={event => setAttemptId(event.target.value)}>{task.attempts.map(row => <option value={row.attemptId} key={row.attemptId}>第 {row.attemptNumber} 次执行 · {TEAM_STATUS_LABELS[row.status]}</option>)}</select></label>}
    {attempt?.result && <><h4>交付结果</h4><MessageMarkdown content={attempt.result} /></>}{attempt?.artifacts.map(artifact => <ArtifactLink key={artifact.artifactId} artifact={artifact} onOpen={onOpenArtifact} />)}
    {rejecting && <label className="team-field">修改意见<textarea rows={3} maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} /><button className="team-button" type="button" disabled={busy || !reason.trim()} onClick={() => void act('reject')}>提交修改意见</button></label>}
    {onAction && <div className="team-task-actions">{task.status === 'awaiting_acceptance' && <><button className="team-button team-primary" type="button" disabled={busy} onClick={() => void act('accept')}>验收通过</button><button className="team-button" type="button" disabled={busy} onClick={() => setRejecting(true)}>提出修改</button></>}{['failed', 'cancelled'].includes(task.status) && <button className="team-button" type="button" disabled={busy} onClick={() => void act('retry')}>重新执行</button>}</div>}{error && <p role="alert" className="team-inline-error">{error}</p>}
  </section>;
}

function InteractionCard({ interaction, member, onRespond }: { interaction: TeamInteraction; member?: AgentMember; onRespond: (input: TeamInteractionInput) => Promise<unknown> }) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<{ digest: string; idempotencyKey: string } | null>(null);
  async function respond(action: TeamInteractionInput['action'], response: Record<string, unknown>) {
    if (busy || submitted) return;
    const digest = JSON.stringify([action, response, interaction.revision]);
    if (pending.current?.digest !== digest) pending.current = { digest, idempotencyKey: key() };
    setBusy(true); setError('');
    try {
      const receipt = await onRespond({ ref: interaction.ref, expectedRevision: interaction.revision, action, response, idempotencyKey: pending.current.idempotencyKey }) as GroupReceipt | undefined;
      if (receipt?.status === 'rejected' || receipt?.status === 'uncertain') throw new Error(receipt.reason || '审批结果尚未确认，请核对后重试。');
      setSubmitted(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '审批提交失败。'); } finally { setBusy(false); }
  }
  return <article className="team-interaction-card"><span className="team-eyebrow">{member?.name || '成员'} · 需要你的确认</span><h3>{interaction.title}</h3><InteractionMessage message={interaction.message} />{submitted || interaction.status === 'resolving' ? <p role="status">已提交，等待执行端确认</p> : interaction.kind === 'input' && interaction.requestSchema ? <InteractionSchemaForm schema={interaction.requestSchema} values={values} onChange={setValues} disabled={busy} onSubmit={() => void respond('submit', values)} onCancel={() => void respond('cancel', {})} /> : <div className="team-task-actions"><button type="button" className="team-button" disabled={busy} onClick={() => void respond('reject', { approved: false })}>拒绝</button><button type="button" className="team-button team-primary" disabled={busy} onClick={() => void respond('approve', { approved: true })}>同意</button></div>}{error && <p role="alert" className="team-inline-error">{error}</p>}</article>;
}

export function TeamInteractionTray({ interactions, members, onRespond }: { interactions: TeamInteraction[]; members: AgentMember[]; onRespond: (input: TeamInteractionInput) => Promise<unknown> }) {
  return <section className="team-interactions" aria-label="团队审批与待处理输入">{interactions.filter(row => ['pending', 'resolving'].includes(row.status)).map(interaction => <InteractionCard key={interactionRefKey(interaction.ref)} interaction={interaction} member={members.find(row => row.memberId === interaction.ref.memberId)} onRespond={onRespond} />)}</section>;
}

export function MemberRail({ members, selectedMemberId, onSelect }: { members: AgentMember[]; selectedMemberId?: string; onSelect: (member: AgentMember) => void }) {
  return <div className="team-member-list">{members.filter(member => member.status !== 'removed').map(member => <button type="button" className="team-member-row" key={member.memberId} onClick={() => onSelect(member)} aria-pressed={selectedMemberId === member.memberId}><Initial name={member.name} /><span><strong>{member.name}<small>{member.role === 'leader' ? 'Leader' : '成员'}</small></strong><span>{memberStatus[member.executionStatus]}{member.binding.kind === 'local_build' ? ' · 本地' : ' · 云端'}</span></span><span aria-hidden="true">→</span></button>)}</div>;
}

export function MemberInspector({ member, observation, onDirectedMessage, onRetry, onCancel, cancelPending = false, cancelBusy = false }: { member: AgentMember; observation?: MemberObservation & { error?: string | null }; onDirectedMessage?: () => void; onRetry?: () => void; onCancel?: () => void; cancelPending?: boolean; cancelBusy?: boolean }) {
  return <section className="team-member-inspector"><div className="team-member-heading"><Initial name={member.name} /><div><h3>{member.name}</h3><span className="team-muted">{member.role === 'leader' ? 'Leader' : '成员'} · {memberStatus[member.executionStatus]}</span></div></div>{member.responsibility && <p className="team-member-responsibility">{member.responsibility}</p>}<div className="team-member-actions">{onDirectedMessage && <button className="team-button" type="button" onClick={onDirectedMessage}>在群内 @成员</button>}{onCancel && member.binding.capabilities.cancel && member.activeRunId && <button className="team-button" type="button" disabled={cancelPending || cancelBusy} onClick={onCancel}>{cancelBusy ? '正在提交…' : cancelPending ? '已请求停止' : '请求停止此执行'}</button>}</div>
    <p className="team-observer-note">执行详情只读。关闭面板不会停止成员。</p>{observation ? <><span className="team-connection" role="status">{connectionLabel[observation.connection]}</span>{observation.error && <p role="alert" className="team-inline-error">{observation.error}</p>}{observation.connection === 'offline' && onRetry && <button className="team-button" type="button" onClick={onRetry}>重新连接</button>}<div className="team-member-transcript">{observation.items.filter(item => item.visibility === 'public' && !(item.kind === 'progress' && Object.keys(item.payload).length === 0)).map(item => <article key={item.itemId} className="team-observer-item"><span className="team-eyebrow">{item.kind === 'assistant_text' ? '回复' : item.kind === 'user_message' ? '输入' : item.kind === 'tool_call' ? '工具调用' : item.kind === 'reasoning' ? '执行思考' : item.kind}</span>{typeof item.payload.text === 'string' ? <MessageMarkdown content={item.payload.text} /> : typeof item.payload.error === 'string' ? <p className="team-inline-error">{item.payload.error}</p> : <details className="team-observer-details"><summary>{String(item.payload.tool || item.payload.summary || item.payload.title || (item.kind === 'tool_call' ? '查看工具结果' : '查看事件详情'))}</summary><pre>{JSON.stringify(item.payload, null, 2)}</pre></details>}</article>)}</div>{!observation.items.length && <p className="team-muted">尚无可展示的运行事件。</p>}</> : <p className="team-muted">{member.activeRunId ? '正在读取执行详情…' : '当前没有进行中的执行。'}</p>}</section>;
}

export type TeamWorkspaceProps = ReconciliationActions & {
  snapshot: GroupSnapshot | null;
  loading?: boolean;
  error?: string | null;
  connection?: ConnectionStatus;
  draft?: string;
  onDraftChange?: (draft: string, teamRunId?: string) => void;
  initialDrafts?: Record<string, string>;
  initialSelection?: { teamRunId?: string; taskId?: string };
  onSelectionChange?: (selection: { teamRunId: string; taskId: string }) => void;
  onSend: (input: GroupMessageInput) => Promise<unknown>;
  onRetry?: () => void;
  onManage?: () => void;
  serverAuthority?: boolean;
  standbyCandidates?: ExecutionBinding[];
  onConfigureStandby?: (run: TeamRun, bindingRef: string) => Promise<LeaderStandbyConfiguration>;
  onControl?: (run: TeamRun, action: TeamControlAction) => Promise<unknown>;
  onAcceptRun?: (run: TeamRun, accepted: boolean, reason?: string) => Promise<unknown>;
  onTaskAction?: (task: TeamTask, action: TaskAction, reason?: string) => Promise<unknown>;
  onRespondInteraction?: (input: TeamInteractionInput) => Promise<unknown>;
  onOpenArtifact?: (artifact: TeamArtifact) => void;
  onMemberSelect?: (member: AgentMember) => void;
  renderMember?: (member: AgentMember, actions: { directedMessage: () => void; teamRunId?: string }, source?: MemberStreamRef) => ReactNode;
  onLoadExecution?: (teamRunId: string, signal: AbortSignal) => Promise<ExecutionSnapshot>;
};

export function TeamWorkspace(props: TeamWorkspaceProps) {
  if (!props.snapshot) return <section className="ksadk-teams team-workspace">{props.loading ? <div className="team-loading" role="status" aria-label="正在加载群组"><span /><span /><span /></div> : <div className="team-empty"><h2>{props.error ? '群组暂不可用' : '选择一个团队，开始协作'}</h2><p>{props.error || '创建群组并选择 Leader，让各有所长的 Agent 共同完成目标。'}</p>{props.onRetry && <button type="button" className="team-button" onClick={props.onRetry}>重试</button>}</div>}</section>;
  return <TeamWorkspaceContent key={`${props.snapshot.group.authorityRef}:${props.snapshot.group.groupId}`} {...props} snapshot={props.snapshot} />;
}

function TeamWorkspaceContent({ snapshot, connection = 'connected', draft: controlledDraft, onDraftChange, initialDrafts, initialSelection, onSelectionChange, onSend, onRetry, error, onManage, serverAuthority, standbyCandidates, onConfigureStandby, onLoadReconciliation, onReconcile, onControl, onAcceptRun, onTaskAction, onRespondInteraction, onOpenArtifact, onMemberSelect, renderMember, onLoadExecution }: TeamWorkspaceProps & { snapshot: GroupSnapshot }) {
  const [draft, setDraft] = useState(initialDrafts?.[initialSelection?.teamRunId || currentTeamRun(snapshot)?.teamRunId || ''] || '');
  const [recipientMemberId, setRecipientMemberId] = useState('');
  const [composerFocus, setComposerFocus] = useState(0);
  const [panel, setPanel] = useState<'tasks' | 'members' | 'artifacts' | null>(null);
  const [executionOpen, setExecutionOpen] = useState(false);
  const [selectedTaskId, setTaskId] = useState(initialSelection?.taskId ?? '');
  const [selectedRunId, setSelectedRunId] = useState(initialSelection?.teamRunId || currentTeamRun(snapshot)?.teamRunId || '');
  const [pendingSelection, setPendingSelection] = useState(false);
  const [selectedMemberId, setSelectedMemberId] = useState('');
  const [selectedSource, setSelectedSource] = useState<MemberStreamRef>();
  const [controlBusy, setControlBusy] = useState(false);
  const [controlError, setControlError] = useState('');
  const [requestChanges, setRequestChanges] = useState(false);
  const [changeReason, setChangeReason] = useState('');
  const panelRef = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const drafts = useRef(new Map<string, { text: string; recipient: string }>(Object.entries(initialDrafts || {}).map(([id, text]) => [id, { text, recipient: '' }])));
  const run = snapshot.teamRuns.find(row => row.teamRunId === selectedRunId) ?? null;
  const missingSelection = Boolean(selectedRunId && !run);
  const tasks = snapshot.tasks.filter(task => task.teamRunId === run?.teamRunId);
  useEffect(() => { if (run) setPendingSelection(false); }, [run]);
  const roster = run ? snapshot.runMembers?.filter(member => member.teamRunId === run.teamRunId) : undefined;
  const members = run && snapshot.runMembers ? roster || [] : snapshot.members.filter(member => member.status !== 'removed');
  const selectedTask = tasks.find(task => task.taskId === selectedTaskId);
  const selectedMember = members.find(member => member.memberId === selectedMemberId);
  const sources = [...snapshot.deliveries.filter(delivery => delivery.teamRunId === run?.teamRunId).map(delivery => delivery.runId), ...tasks.flatMap(task => task.attempts.map(attempt => attempt.source?.runId))].filter(Boolean);
  const legacySingleRun = !snapshot.runMembers && snapshot.teamRuns.length === 1;
  const belongsToRun = (source: MemberStreamRef) => Boolean(run && (sources.includes(source.runId) || roster?.some(member => member.sessionId === source.sessionId) || (legacySingleRun && members.some(member => member.sessionId === source.sessionId))));
  const interactions = snapshot.interactions.filter(row => belongsToRun(row.ref));
  const artifacts = [...new Map([...(snapshot.artifacts || []).filter(artifact => belongsToRun(artifact.source)), ...tasks.flatMap(task => task.attempts.flatMap(attempt => attempt.artifacts))].filter(artifact => artifact.source.groupId === snapshot.group.groupId && artifact.source.authorityRef === snapshot.group.authorityRef).map(artifact => [artifact.artifactId, artifact])).values()];
  const pendingCount = interactions.filter(row => row.status === 'pending').length + ((run?.policy || snapshot.group.policy)?.taskAcceptance === 'leader' ? 0 : tasks.filter(task => taskSection(task) === 'attention').length);
  const value = controlledDraft ?? draft;
  function changeDraft(text: string) { setDraft(text); onDraftChange?.(text, selectedRunId); drafts.current.set(selectedRunId, { text, recipient: recipientMemberId }); }
  function chooseRun(id: string) {
    drafts.current.set(selectedRunId, { text: value, recipient: recipientMemberId });
    const saved = drafts.current.get(id);
    setSelectedRunId(id); setPendingSelection(false); setTaskId(''); setSelectedMemberId(''); setSelectedSource(undefined); setRecipientMemberId(saved?.recipient || ''); setDraft(saved?.text || ''); onDraftChange?.(saved?.text || '', id); setControlError(''); setRequestChanges(false); setChangeReason(''); setExecutionOpen(false);
    onSelectionChange?.({ teamRunId: id, taskId: '' });
  }
  function setSelectedTaskId(taskId: string) { setTaskId(taskId); onSelectionChange?.({ teamRunId: run?.teamRunId ?? '', taskId }); }
  function openPanel(next: 'tasks' | 'members' | 'artifacts') { returnFocus.current = document.activeElement as HTMLElement; setPanel(next); setSelectedMemberId(''); }
  function closePanel() { setPanel(null); setExecutionOpen(false); returnFocus.current?.focus(); }
  function directToMember(member: AgentMember) { setRecipientMemberId(member.memberId); setPanel(null); setExecutionOpen(false); setComposerFocus(value => value + 1); }
  function selectMember(member: AgentMember) { setSelectedSource(undefined); setSelectedMemberId(member.memberId); setPanel('members'); onMemberSelect?.(member); }
  useEffect(() => { if (panel) panelRef.current?.focus(); }, [panel]);
  async function control(action: TeamControlAction) { if (!run || !onControl || controlBusy) return; setControlBusy(true); setControlError(''); try { await onControl(run, action); } catch (cause) { setControlError(cause instanceof Error ? cause.message : '操作失败。'); } finally { setControlBusy(false); } }
  async function acceptRun(accepted: boolean) {
    if (!run || !onAcceptRun || controlBusy) return;
    if (!accepted && !changeReason.trim()) { setControlError('请说明需要修改的内容。'); return; }
    setControlBusy(true); setControlError('');
    try { await onAcceptRun(run, accepted, accepted ? undefined : changeReason.trim()); setRequestChanges(false); setChangeReason(''); }
    catch (cause) { setControlError(cause instanceof Error ? cause.message : '验收提交失败。'); }
    finally { setControlBusy(false); }
  }
  async function send(input: GroupMessageInput) {
    const receipt = await onSend(input) as GroupReceipt | undefined;
    if (receipt?.teamRunId && !input.teamRunId && ['accepted', 'duplicate'].includes(receipt.status)) {
      drafts.current.set('', { text: '', recipient: '' });
      setSelectedRunId(receipt.teamRunId); setPendingSelection(true); setDraft(''); onDraftChange?.('', ''); setRecipientMemberId('');
      onSelectionChange?.({ teamRunId: receipt.teamRunId, taskId: '' });
    }
    return receipt;
  }
  const finalAcceptance = run?.status === 'awaiting_acceptance' && onAcceptRun && <section className="team-final-delivery" aria-label="最终验收"><span className="team-eyebrow">团队已提交成果</span><h3>请确认这次交付</h3>{run.result && <div className="team-final-summary"><MessageMarkdown content={run.result} /></div>}<p>验收通过后完成任务；提出修改会交给 Leader 继续推进。</p>{requestChanges && <label className="team-field">修改意见<textarea value={changeReason} onChange={event => setChangeReason(event.target.value)} placeholder="哪些内容需要调整？期望是什么？" rows={3} maxLength={2000} disabled={controlBusy} /></label>}<div className="team-task-actions">{requestChanges ? <><button className="team-button" type="button" disabled={controlBusy} onClick={() => setRequestChanges(false)}>取消修改</button><button className="team-button team-primary" type="button" disabled={controlBusy || !changeReason.trim()} onClick={() => void acceptRun(false)}>提交修改意见</button></> : <><button className="team-button" type="button" disabled={controlBusy} onClick={() => setRequestChanges(true)}>提出修改</button><button className="team-button team-primary" type="button" disabled={controlBusy} onClick={() => void acceptRun(true)}>通过验收</button></>}</div>{controlError && <p role="alert" className="team-inline-error">{controlError}</p>}</section>;
  return <section className="ksadk-teams team-workspace" data-panel={panel || 'closed'} data-execution={executionOpen ? 'open' : 'closed'}>
    <GroupHeader snapshot={snapshot} connection={connection} onProgress={() => openPanel('tasks')} onMembers={() => openPanel('members')} onManage={onManage} />
    {error && <div className="team-top-error" role="alert">{error}{onRetry && <button className="team-text-button" type="button" onClick={onRetry}>重新连接</button>}</div>}
    <div className="team-body">
      <nav className="team-run-directory" aria-label="团队任务"><header><h2>任务</h2><button type="button" className="team-text-button" onClick={() => { chooseRun(''); setComposerFocus(value => value + 1); }}>＋ 新任务</button></header><div className="team-run-list">{[...snapshot.teamRuns].reverse().map(row => <button type="button" className="team-run-item" key={row.teamRunId} aria-current={row.teamRunId === selectedRunId ? 'page' : undefined} onClick={() => chooseRun(row.teamRunId)}><strong>{row.goal}</strong><TeamStatusLabel status={row.status} /></button>)}{!snapshot.teamRuns.length && <p className="team-muted">每个目标是一个独立任务。</p>}</div></nav>
      <div className="team-chat-pane" aria-hidden={executionOpen || undefined}>
        <header className="team-task-heading"><div><span className="team-eyebrow">{run ? '当前任务' : '新的目标'}</span><h2>{run?.goal || (missingSelection ? pendingSelection ? '正在同步任务…' : '未找到所选任务' : '希望团队完成什么？')}</h2></div><button type="button" className="team-button" aria-label="查看任务详情" onClick={() => openPanel('tasks')}>详情</button></header>
        <label className="team-mobile-task-picker team-field">切换任务<select value={selectedRunId} onChange={event => chooseRun(event.target.value)}><option value="">＋ 新任务</option>{snapshot.teamRuns.map(row => <option value={row.teamRunId} key={row.teamRunId}>{row.goal}</option>)}</select></label>
        <GroupTimeline key={selectedRunId} emptyState={missingSelection ? <div className="team-empty" role="status"><p>{pendingSelection ? "正在读取刚创建的任务，消息已提交。" : "请从任务列表重新选择；当前输入不会发送到其他任务。"}</p>{onRetry && <button className="team-button" type="button" onClick={onRetry}>重新读取</button>}</div> : undefined} focusFinalDelivery={finalAcceptance ? run?.teamRunId : undefined} messages={snapshot.messages.filter(message => run ? message.teamRunId === run.teamRunId || (legacySingleRun && !message.teamRunId) : false)}>{run && <TeamProgressCard compact run={run} tasks={tasks} pendingCount={pendingCount} onOpen={() => openPanel('tasks')} />}{finalAcceptance}</GroupTimeline>
        {pendingCount > 0 && <button type="button" className="team-attention-banner" onClick={() => openPanel('tasks')}>{pendingCount} 项需要处理 <span>查看 <span aria-hidden="true">→</span></span></button>}
        <GroupComposer serverAuthority={serverAuthority} referenceArtifacts={[...new Map([...(snapshot.artifacts || []), ...snapshot.tasks.flatMap(task => task.attempts.flatMap(attempt => attempt.artifacts))].filter(artifact => artifact.source.groupId === snapshot.group.groupId && artifact.source.authorityRef === snapshot.group.authorityRef).map(artifact => [artifact.artifactId, artifact])).values()]} artifacts={artifacts} recipientMemberId={recipientMemberId} onRecipientChange={setRecipientMemberId} focusRequest={composerFocus} members={members} activeRun={run} value={value} onChange={changeDraft} onSend={send} disabled={snapshot.group.status !== 'active' || missingSelection} />
      </div>
      {panel && <aside className="team-sidepanel" ref={panelRef} tabIndex={-1} aria-label="任务详情" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); closePanel(); } }}><header className="team-panel-header"><nav className="team-detail-tabs" aria-label="任务详情分类">{([['tasks', '进度'], ['members', '成员'], ['artifacts', '交付物']] as const).map(([id, label]) => <button type="button" key={id} aria-pressed={panel === id} onClick={() => openPanel(id)}>{label}</button>)}</nav><button type="button" className="team-button team-icon-button" aria-label="关闭详情" onClick={closePanel}>×</button></header><div className="team-panel-scroll">
        {panel === 'tasks' ? <>{run && <div className="team-run-overview"><TeamStatusLabel status={run.status} /><RunGoal goal={run.goal} />{run.reason && <p>{run.reason}</p>}{onControl && isTeamRunActive(run.status) && <div className="team-run-actions"><button className="team-text-button" type="button" disabled={controlBusy || run.status === 'cancel_requested'} onClick={() => void control(run.dispatchSuspended ? 'resume_dispatch' : 'suspend_dispatch')}>{run.dispatchSuspended ? '继续协作' : '暂停派发'}</button><button className="team-text-button team-danger" type="button" disabled={controlBusy || run.status === 'cancel_requested'} onClick={() => void control('stop')}>停止任务</button></div>}{controlError && !finalAcceptance && <p role="alert" className="team-inline-error">{controlError}</p>}<LeaderStandby run={run} enabled={serverAuthority} candidates={standbyCandidates || []} configure={onConfigureStandby} /><TeamReconciliation key={run.teamRunId} run={run} onLoadReconciliation={onLoadReconciliation} onReconcile={onReconcile} /><details className="team-run-budget"><summary>执行限额</summary><dl><div><dt>累计启动</dt><dd>{run.budget.startsUsed} / {run.budget.maxStarts}</dd></div><div><dt>同时执行</dt><dd>最多 {run.budget.maxConcurrent} 个</dd></div>{run.budget.maxTokens && <div><dt>Token</dt><dd>{run.budget.tokensUsed ?? 0} / {run.budget.maxTokens}</dd></div>}{run.budget.maxDurationSeconds && <div><dt>主动执行时限</dt><dd>{Math.round(run.budget.maxDurationSeconds / 60)} 分钟</dd></div>}</dl></details></div>}
          {onRespondInteraction && <TeamInteractionTray interactions={interactions} members={members} onRespond={onRespondInteraction} />}
          {selectedTask ? <><button className="team-text-button team-back" type="button" onClick={() => setSelectedTaskId('')}>← 所有分工</button><TaskDetail key={selectedTask.taskId} task={selectedTask} members={members} onAction={(run?.policy || snapshot.group.policy)?.taskAcceptance === 'leader' ? undefined : onTaskAction} onOpenArtifact={onOpenArtifact} onMemberSelect={selectMember} /></> : <TaskBoard tasks={tasks} members={members} selectedTaskId={selectedTaskId} onSelect={task => setSelectedTaskId(task.taskId)} />}
        </> : panel === 'artifacts' ? <section className="team-artifact-list"><h3>任务交付物</h3>{artifacts.length ? artifacts.map(artifact => <ArtifactLink key={artifact.artifactId} artifact={artifact} onOpen={onOpenArtifact} />) : <p className="team-muted">成员发布的成果会保存在这里。</p>}</section> : selectedMember ? <><button className="team-text-button team-back" type="button" onClick={() => setSelectedMemberId('')}>← 所有成员</button>{renderMember?.(selectedMember, { directedMessage: () => directToMember(selectedMember), teamRunId: run?.teamRunId }, selectedSource) ?? <MemberInspector member={selectedMember} onDirectedMessage={() => directToMember(selectedMember)} />}</> : <MemberRail members={members} selectedMemberId={selectedMemberId} onSelect={selectMember} />}
      </div>{panel === 'tasks' && (tasks.length > 0 || Boolean(onLoadExecution && run)) && <footer className="team-panel-footer"><button className="team-button team-expand" type="button" onClick={() => setExecutionOpen(true)}>查看执行详情 <span aria-hidden="true">↗</span></button></footer>}</aside>}
      {executionOpen && <section className="team-execution-workspace" aria-label="执行工作台"><header className="team-panel-header"><div><span className="team-eyebrow">执行详情</span><h2>{run?.goal}</h2></div><button className="team-button" type="button" onClick={() => setExecutionOpen(false)}>返回聊天</button></header><Suspense fallback={<div className="team-loading" role="status" aria-label="正在加载执行视图"><span /><span /></div>}><LoadedExecutionTree key={`${snapshot.group.groupId}:${run?.teamRunId || ''}`} authorityRef={snapshot.group.authorityRef} groupId={snapshot.group.groupId} teamRunId={run?.teamRunId || ''} watermark={snapshot.watermark} load={onLoadExecution} tasks={tasks} members={members} selectedTaskId={selectedTaskId} onSelect={task => { setSelectedTaskId(task.taskId); setExecutionOpen(false); setPanel('tasks'); }} onSelectNode={node => { if (node.kind === 'task' && node.taskId) { setSelectedTaskId(node.taskId); setPanel('tasks'); setExecutionOpen(false); } else if (node.source) { setSelectedMemberId(node.source.memberId); setSelectedSource(node.source); setPanel('members'); setExecutionOpen(false); } }} /></Suspense></section>}
    </div>
  </section>;
}

function LeaderStandby({ run, enabled, candidates, configure }: { run: TeamRun; enabled?: boolean; candidates: ExecutionBinding[]; configure?: (run: TeamRun, bindingRef: string) => Promise<LeaderStandbyConfiguration> }) {
  const [bindingRef, setBindingRef] = useState(run.leaderStandby?.standbyBindingRef || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [configured, setConfigured] = useState(run.leaderStandby);
  const eligible = candidates.filter(binding => binding.kind !== 'local_build' && ['ready', 'unchecked'].includes(binding.availability?.state || '') && binding.capabilities.leader && binding.capabilities.enqueue);
  useEffect(() => { setBindingRef(run.leaderStandby?.standbyBindingRef || ''); setError(''); setConfigured(run.leaderStandby); }, [run.teamRunId, run.leaderStandby]);
  if (!enabled || !configure || (!eligible.length && !configured)) return null;
  async function save() {
    if (!bindingRef || busy || !configure) return;
    setBusy(true); setError('');
    try { setConfigured(await configure(run, bindingRef)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '备用配置失败。'); }
    finally { setBusy(false); }
  }
  const reasons: Record<string, string> = { standby_offline: '云端备用节点离线，正在等待恢复。', checkpoint_required: '正在等待 Leader 保存可恢复的任务进度。', execution_uncertain: '正在核对原执行结果，避免重复执行。' };
  return <details className="team-run-budget team-standby"><summary>云端接管设置{configured?.state === 'active' ? ' · 已接管' : configured?.state === 'blocked' ? ' · 等待恢复' : ''}</summary>{configured && <p role="status">{configured.state === 'active' ? '云端 Leader 已接管当前任务。' : configured.state === 'armed' ? '兼容的备用节点已配置；接管前会保存进度并核对原执行。' : reasons[configured.reason || ''] || '暂时无法接管，请检查执行状态。'}</p>}{isTeamRunActive(run.status) && !!eligible.length && <><label className="team-field">Leader 备用节点<select value={bindingRef} onChange={event => setBindingRef(event.target.value)} disabled={busy}><option value="">选择云端节点，保存时检查</option>{eligible.map(binding => <option value={binding.bindingRef} key={binding.bindingRef}>{binding.name || binding.agentId}</option>)}</select></label><p>本地 Leader 失联后由备用节点继续。新任务沿用此配置；本地恢复时不抢回当前任务。</p><button type="button" className="team-button" disabled={busy || !bindingRef} onClick={() => void save()}>{busy ? '正在校验…' : '配置备用节点'}</button></>}{error && <p role="alert" className="team-inline-error">{error}</p>}</details>;
}

function LoadedExecutionTree({ authorityRef, groupId, teamRunId, watermark, load, ...props }: { authorityRef: string; groupId: string; teamRunId: string; watermark: number; load?: (teamRunId: string, signal: AbortSignal) => Promise<ExecutionSnapshot>; tasks: TeamTask[]; members: AgentMember[]; selectedTaskId?: string; onSelect: (task: TeamTask) => void; onSelectNode: (node: ExecutionNode) => void }) {
  const loader = useRef(load);
  const canLoad = Boolean(load);
  useEffect(() => { loader.current = load; }, [load]);
  const [execution, setExecution] = useState<ExecutionSnapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(Boolean(load));
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!loader.current || !teamRunId) return;
    const controller = new AbortController();
    void loader.current(teamRunId, controller.signal).then(result => { if (!controller.signal.aborted) { if (result.groupId !== groupId || result.teamRunId !== teamRunId || result.nodes.some(node => node.source && node.source.authorityRef !== authorityRef)) throw new Error('执行视图不属于当前协作轮次。'); setExecution(result); setError(''); } }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '执行视图加载失败。'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [authorityRef, groupId, teamRunId, watermark, retry, canLoad]);
  return <LazyExecutionTree {...props} execution={execution} executionLoading={loading} executionError={error} onRetryExecution={load ? () => { setError(''); setLoading(true); setRetry(value => value + 1); } : undefined} />;
}
