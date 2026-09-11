import { lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { InteractionMessage } from './InteractionMessage.js';
import { MessageMarkdown } from '../MessageMarkdown.js';
import { InteractionSchemaForm } from '../chat/InteractionSchemaForm.js';
import { currentTeamRun, isTeamRunActive, safeArtifactUri, taskDisplayReason, taskSection, TEAM_STATUS_LABELS } from '../../core/teams/presentation.js';
import { interactionRefKey } from '../../core/teams/reducer.js';
import type { AgentMember, ConnectionStatus, GroupMessage, GroupMessageInput, GroupReceipt, GroupSnapshot, MemberObservation, TaskAction, TeamArtifact, TeamControlAction, TeamInteraction, TeamInteractionInput, TeamRun, TeamTask, ExecutionNode, ExecutionSnapshot, MemberStreamRef, GroupMessagePart } from '../../core/teams/types.js';

const LazyExecutionTree = lazy(() => import('./ExecutionTree.js').then(module => ({ default: module.ExecutionTree })));
const key = () => `team-${globalThis.crypto.randomUUID()}`;
const roles = { owner: '群主', leader: 'Leader', member: '成员', system: '系统' };
const memberStatus = { idle: '空闲', queued: '待执行', running: '进行中', waiting: '等待中', needs_attention: '需要处理', unavailable: '不可用' };
const connectionLabel: Record<ConnectionStatus, string> = { connecting: '正在连接', connected: '已连接', reconnecting: '正在重连 · 任务继续执行', offline: '连接中断 · 显示最后状态', closed: '未连接' };

function Initial({ name }: { name: string }) { return <span className="team-avatar" aria-hidden="true">{Array.from(name.trim())[0] || 'A'}</span>; }
export function TeamStatusLabel({ status }: { status: string }) { return <span className="team-status" data-status={status}>{TEAM_STATUS_LABELS[status as keyof typeof TEAM_STATUS_LABELS] ?? status}</span>; }

export function GroupHeader({ snapshot, connection, onProgress, onMembers, onManage }: { snapshot: GroupSnapshot; connection: ConnectionStatus; onProgress: () => void; onMembers: () => void; onManage?: () => void }) {
  const active = snapshot.members.filter(member => member.status !== 'removed');
  const run = currentTeamRun(snapshot);
  return <header className="team-header">
    <div className="team-header-identity"><div className="team-avatar-stack" aria-hidden="true">{active.slice(0, 3).map(member => <Initial key={member.memberId} name={member.name} />)}</div><div><h1>{snapshot.group.name}</h1><button type="button" className="team-text-button team-muted" onClick={onMembers}>{active.length} 位成员 · {active.find(member => member.memberId === snapshot.group.leaderMemberId)?.name || 'Leader'}</button></div></div>
    <div className="team-header-actions">{connection !== 'connected' && <span className="team-connection" role="status">{connectionLabel[connection]}</span>}{onManage && <button type="button" className="team-button" onClick={onManage}>设置</button>}{run && <button type="button" className="team-button" onClick={onProgress}>本轮进展</button>}</div>
  </header>;
}

export function GroupTimeline({ messages, children, emptyState }: { messages: GroupMessage[]; children?: ReactNode; emptyState?: ReactNode }) {
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [limit, setLimit] = useState(100);
  const visible = messages.filter(message => message.visibility === 'public');
  useLayoutEffect(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [messages, children]);
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
      {!visible.length && (emptyState ?? <div className="team-empty"><span className="team-eyebrow">一起完成一个目标</span><h2>团队已就绪</h2><p>描述你想得到的成果，Leader 会组织成员分工。<br />先发送目标启动协作，再按需 @成员。</p></div>)}
      {visible.slice(-limit).map(message => <article key={message.messageId} className="team-message" data-role={message.groupRole} data-message-id={message.messageId}>
        {message.groupRole !== 'owner' && <Initial name={message.senderName} />}
        <div className="team-message-main"><header><strong>{message.senderName}</strong><span>{roles[message.groupRole]}</span><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>{message.intent === 'note' && <span>仅留言</span>}</header><div className="team-message-body">{message.parts.map((part, index) => part.kind === 'text' ? <MessageMarkdown key={index} content={part.text} /> : <span className="team-attachment" key={part.attachmentRef}>{part.name || '附件'} <span>{part.mediaType}</span></span>)}</div></div>
      </article>)}
      {children}
    </div>
  </div>;
}

export function TeamProgressCard({ run, tasks, pendingCount, onOpen }: { run: TeamRun; tasks: TeamTask[]; pendingCount: number; onOpen: () => void }) {
  const accepted = tasks.filter(task => task.status === 'succeeded').length;
  return <button type="button" className="team-progress-card" onClick={onOpen} aria-label={`查看协作：${run.goal}`}>
    <span className="team-progress-heading"><span className="team-eyebrow">本轮协作</span><TeamStatusLabel status={run.status} /></span>
    <strong>{run.goal}</strong><span className="team-progress-caption">{tasks.length ? `${accepted} / ${tasks.length} 项任务已验收` : '正在整理目标与分工'}{pendingCount > 0 ? ` · ${pendingCount} 项需要处理` : ''}<span>查看协作 <span aria-hidden="true">→</span></span></span>
    {run.reason && <span className="team-progress-reason">{run.reason}</span>}
  </button>;
}

export function GroupComposer({ members, activeRun, value, onChange, onSend, disabled = false, recipientMemberId, onRecipientChange, focusRequest = 0, artifacts = [] }: { members: AgentMember[]; activeRun: TeamRun | null; value: string; onChange: (value: string) => void; onSend: (input: GroupMessageInput) => Promise<unknown>; disabled?: boolean; recipientMemberId?: string; onRecipientChange?: (memberId: string) => void; focusRequest?: number; artifacts?: TeamArtifact[] }) {
  const inputId = useId();
  const recipientId = useId();
  const artifactId = useId();
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const attachments = artifacts.filter(artifact => attachmentIds.includes(artifact.artifactId));
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
  const [note, setNote] = useState(false);
  const [sending, setSending] = useState(false);
  const hasActiveRun = Boolean(activeRun && isTeamRunActive(activeRun.status));
  const directedUnavailable = Boolean(target && !note && !hasActiveRun);
  const [error, setError] = useState('');
  const pending = useRef<{ digest: string; idempotencyKey: string } | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const mentionQuery = /@([^\s@]*)$/u.exec(value)?.[1];
  const mentionOptions = mentionQuery !== undefined ? members.filter(member => member.status === 'active' && member.name.toLowerCase().includes(mentionQuery.toLowerCase())) : [];
  async function submit() {
    if (disabled || sending || (!value.trim() && !attachments.length)) return;
    if (directedUnavailable) { setError('请先选择发给 Leader，启动本轮目标；也可以选择仅留言。'); return; }
    const text = value.trim();
    const intent = note ? 'note' : target !== '' ? 'directed' : activeRun && isTeamRunActive(activeRun.status) ? 'followup' : 'start_goal';
    if (intent === 'start_goal' && !text) { setError('请补充这轮希望团队完成的目标，或选择仅留言。'); return; }
    const mentions = target === '' ? [] : [target];
    const parts: GroupMessagePart[] = [...(text ? [{ kind: 'text' as const, text }] : []), ...attachments.map(artifact => ({ kind: 'attachment' as const, attachmentRef: artifact.artifactId, mediaType: artifact.mediaType, name: artifact.name }))];
    const digest = JSON.stringify([parts, intent, mentions]);
    if (pending.current?.digest !== digest) pending.current = { digest, idempotencyKey: key() };
    setSending(true); setError('');
    try {
      const receipt = await onSend({ parts, mentions, intent, idempotencyKey: pending.current.idempotencyKey }) as GroupReceipt | undefined;
      if (!mounted.current) return;
      if (receipt?.status === 'rejected' || receipt?.status === 'uncertain') throw new Error(receipt.reason || (receipt.status === 'uncertain' ? '消息接收结果尚未确认。再次提交将使用相同标识核对。' : '消息未被接收。'));
      onChange(''); setAttachmentIds([]); pending.current = null;
    } catch (cause) { setError(cause instanceof Error ? cause.message : '消息发送失败，请重试。'); }
    finally { setSending(false); }
  }
  return <form className="team-composer-wrap" onSubmit={event => { event.preventDefault(); void submit(); }}>
    {error && <p className="team-inline-error" role="alert">{error}</p>}
    {!!mentionOptions.length && <div className="team-mention-options" aria-label="选择要提及的成员">{mentionOptions.map(member => <button type="button" key={member.memberId} onClick={() => { setTarget(member.memberId); onChange(value.replace(/@([^\s@]*)$/u, `@${member.name} `)); }}><Initial name={member.name} /><span>{member.name}</span><small>{member.role === 'leader' ? 'Leader' : '成员'}</small></button>)}</div>}
    {!!attachments.length && <div className="team-selected-artifacts" aria-label="已选择的交付物">{attachments.map(artifact => <span className="team-attachment" key={artifact.artifactId}>{artifact.name}<button type="button" className="team-text-button" aria-label={`移除引用 ${artifact.name}`} disabled={sending} onClick={() => setAttachmentIds(ids => ids.filter(id => id !== artifact.artifactId))}>×</button></span>)}</div>}
    <div className="team-composer"><label className="team-sr-only" htmlFor={inputId}>给团队的消息</label><textarea ref={textarea} id={inputId} value={value} rows={3} onChange={event => onChange(event.target.value)} placeholder={note ? '留下一条消息，不启动任务…' : target === '' ? '描述目标、交付物或需要团队解决的问题…' : '向选中的成员提问或分派工作…'} disabled={disabled || sending} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
      <div className="team-composer-toolbar"><div><label className="team-sr-only" htmlFor={recipientId}>接收成员</label><select id={recipientId} value={target} onChange={event => setTarget(event.target.value)} disabled={disabled || sending}><option value="">发给 Leader</option>{members.filter(member => member.status === 'active').map(member => <option key={member.memberId} value={member.memberId} disabled={!hasActiveRun && !note}>@{member.name}</option>)}</select><label className="team-note-toggle"><input type="checkbox" checked={note} onChange={event => setNote(event.target.checked)} disabled={disabled || sending} />仅留言</label>{!!artifacts.length && <><label className="team-sr-only" htmlFor={artifactId}>引用本群交付物</label><select id={artifactId} value="" disabled={disabled || sending || attachments.length >= 8} onChange={event => { const id = event.target.value; if (id) setAttachmentIds(ids => ids.includes(id) ? ids : [...ids, id]); }}><option value="">引用交付物</option>{artifacts.filter(artifact => !attachmentIds.includes(artifact.artifactId)).map(artifact => <option key={artifact.artifactId} value={artifact.artifactId}>{artifact.name}</option>)}</select></>}</div><button className="team-button team-primary" type="submit" disabled={disabled || sending || directedUnavailable || (!value.trim() && !attachments.length)}>{sending ? '正在发送' : '发送'}</button></div>
    </div><p className="team-composer-help">{directedUnavailable ? '本轮已结束，请切换到 Leader 发起新目标，或选择仅留言。' : <>Enter 发送 · Shift + Enter 换行{note ? ' · 留言不会唤醒成员' : ''}</>}</p>
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

export function TaskDetail({ task, members, onAction, onOpenArtifact, onMemberSelect }: { task: TeamTask; members: AgentMember[]; onAction?: (task: TeamTask, action: TaskAction) => Promise<unknown>; onOpenArtifact?: (artifact: TeamArtifact) => void; onMemberSelect?: (member: AgentMember) => void }) {
  const [attemptId, setAttemptId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const attempt = task.attempts.find(row => row.attemptId === attemptId) ?? task.attempts.at(-1);
  const member = members.find(row => row.memberId === task.ownerMemberId);
  async function act(action: TaskAction) { if (!onAction || busy) return; setBusy(true); setError(''); try { await onAction(task, action); } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败。'); } finally { setBusy(false); } }
  return <section className="team-task-detail"><TeamStatusLabel status={task.status} /><h3>{task.title}</h3>{member && <button className="team-member-link" type="button" onClick={() => onMemberSelect?.(member)} disabled={!onMemberSelect}><Initial name={member.name} />{member.name}<span>查看执行</span></button>}<p>{task.description}</p>{taskDisplayReason(task) && <p className="team-detail-reason">{taskDisplayReason(task)}</p>}
    <h4>验收要求</h4><p>{task.acceptanceCriteria || '等待确定验收要求'}</p>
    {task.attempts.length > 1 && <label className="team-field">执行记录<select value={attempt?.attemptId} onChange={event => setAttemptId(event.target.value)}>{task.attempts.map(row => <option value={row.attemptId} key={row.attemptId}>第 {row.attemptNumber} 次执行 · {TEAM_STATUS_LABELS[row.status]}</option>)}</select></label>}
    {attempt?.result && <><h4>交付结果</h4><MessageMarkdown content={attempt.result} /></>}{attempt?.artifacts.map(artifact => <ArtifactLink key={artifact.artifactId} artifact={artifact} onOpen={onOpenArtifact} />)}
    {onAction && <div className="team-task-actions">{task.status === 'awaiting_acceptance' && <><button className="team-button team-primary" type="button" disabled={busy} onClick={() => void act('accept')}>验收通过</button><button className="team-button" type="button" disabled={busy} onClick={() => void act('reject')}>退回修改</button></>}{['failed', 'cancelled'].includes(task.status) && <button className="team-button" type="button" disabled={busy} onClick={() => void act('retry')}>重新执行</button>}</div>}{error && <p role="alert" className="team-inline-error">{error}</p>}
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
  return <div className="team-member-list">{members.filter(member => member.status !== 'removed').map(member => <button type="button" className="team-member-row" key={member.memberId} onClick={() => onSelect(member)} aria-pressed={selectedMemberId === member.memberId}><Initial name={member.name} /><span><strong>{member.name}<small>{member.role === 'leader' ? 'Leader' : '成员'}</small></strong><span>{memberStatus[member.executionStatus]}{member.binding.kind === 'a2a' ? ' · 云端' : ' · 本机'}</span></span><span aria-hidden="true">→</span></button>)}</div>;
}

export function MemberInspector({ member, observation, onDirectedMessage, onRetry, onCancel, cancelPending = false, cancelBusy = false }: { member: AgentMember; observation?: MemberObservation & { error?: string | null }; onDirectedMessage?: () => void; onRetry?: () => void; onCancel?: () => void; cancelPending?: boolean; cancelBusy?: boolean }) {
  return <section className="team-member-inspector"><div className="team-member-heading"><Initial name={member.name} /><div><h3>{member.name}</h3><span className="team-muted">{member.role === 'leader' ? 'Leader' : '成员'} · {memberStatus[member.executionStatus]}</span></div></div><div className="team-member-actions">{onDirectedMessage && <button className="team-button" type="button" onClick={onDirectedMessage}>在群内 @成员</button>}{onCancel && member.binding.capabilities.cancel && member.activeRunId && <button className="team-button" type="button" disabled={cancelPending || cancelBusy} onClick={onCancel}>{cancelBusy ? '正在提交…' : cancelPending ? '已请求停止' : '请求停止此执行'}</button>}</div>
    <p className="team-observer-note">执行详情只读。关闭面板不会停止成员。</p>{observation ? <><span className="team-connection" role="status">{connectionLabel[observation.connection]}</span>{observation.error && <p role="alert" className="team-inline-error">{observation.error}</p>}{observation.connection === 'offline' && onRetry && <button className="team-button" type="button" onClick={onRetry}>重新连接</button>}<div className="team-member-transcript">{observation.items.filter(item => item.visibility === 'public' && !(item.kind === 'progress' && Object.keys(item.payload).length === 0)).map(item => <article key={item.itemId} className="team-observer-item"><span className="team-eyebrow">{item.kind === 'assistant_text' ? '回复' : item.kind === 'user_message' ? '输入' : item.kind === 'tool_call' ? '工具调用' : item.kind === 'reasoning' ? '执行思考' : item.kind}</span>{typeof item.payload.text === 'string' ? <MessageMarkdown content={item.payload.text} /> : typeof item.payload.error === 'string' ? <p className="team-inline-error">{item.payload.error}</p> : <details className="team-observer-details"><summary>{String(item.payload.tool || item.payload.summary || item.payload.title || (item.kind === 'tool_call' ? '查看工具结果' : '查看事件详情'))}</summary><pre>{JSON.stringify(item.payload, null, 2)}</pre></details>}</article>)}</div>{!observation.items.length && <p className="team-muted">尚无可展示的运行事件。</p>}</> : <p className="team-muted">{member.activeRunId ? '正在读取执行详情…' : '当前没有进行中的执行。'}</p>}</section>;
}

export type TeamWorkspaceProps = {
  snapshot: GroupSnapshot | null;
  loading?: boolean;
  error?: string | null;
  connection?: ConnectionStatus;
  draft?: string;
  onDraftChange?: (draft: string) => void;
  initialSelection?: { teamRunId?: string; taskId?: string };
  onSelectionChange?: (selection: { teamRunId: string; taskId: string }) => void;
  onSend: (input: GroupMessageInput) => Promise<unknown>;
  onRetry?: () => void;
  onManage?: () => void;
  onControl?: (run: TeamRun, action: TeamControlAction) => Promise<unknown>;
  onAcceptRun?: (run: TeamRun, accepted: boolean) => Promise<unknown>;
  onTaskAction?: (task: TeamTask, action: TaskAction) => Promise<unknown>;
  onRespondInteraction?: (input: TeamInteractionInput) => Promise<unknown>;
  onOpenArtifact?: (artifact: TeamArtifact) => void;
  onMemberSelect?: (member: AgentMember) => void;
  renderMember?: (member: AgentMember, actions: { directedMessage: () => void }, source?: MemberStreamRef) => ReactNode;
  onLoadExecution?: (teamRunId: string, signal: AbortSignal) => Promise<ExecutionSnapshot>;
};

export function TeamWorkspace(props: TeamWorkspaceProps) {
  if (!props.snapshot) return <section className="ksadk-teams team-workspace">{props.loading ? <div className="team-loading" role="status" aria-label="正在加载群组"><span /><span /><span /></div> : <div className="team-empty"><h2>{props.error ? '群组暂不可用' : '选择一个团队，开始协作'}</h2><p>{props.error || '创建群组并选择 Leader，让各有所长的 Agent 共同完成目标。'}</p>{props.onRetry && <button type="button" className="team-button" onClick={props.onRetry}>重试</button>}</div>}</section>;
  return <TeamWorkspaceContent key={`${props.snapshot.group.authorityRef}:${props.snapshot.group.groupId}`} {...props} snapshot={props.snapshot} />;
}

function TeamWorkspaceContent({ snapshot, connection = 'connected', draft: controlledDraft, onDraftChange, initialSelection, onSelectionChange, onSend, onRetry, error, onManage, onControl, onAcceptRun, onTaskAction, onRespondInteraction, onOpenArtifact, onMemberSelect, renderMember, onLoadExecution }: TeamWorkspaceProps & { snapshot: GroupSnapshot }) {
  const [draft, setDraft] = useState('');
  const [recipientMemberId, setRecipientMemberId] = useState('');
  const [composerFocus, setComposerFocus] = useState(0);
  const [panel, setPanel] = useState<'tasks' | 'members' | null>(null);
  const [executionOpen, setExecutionOpen] = useState(false);
  const [selectedTaskId, setTaskId] = useState(initialSelection?.taskId ?? '');
  const [selectedRunId, setSelectedRunId] = useState(initialSelection?.teamRunId ?? '');
  const [selectedMemberId, setSelectedMemberId] = useState('');
  const [selectedSource, setSelectedSource] = useState<MemberStreamRef>();
  const [controlBusy, setControlBusy] = useState(false);
  const [controlError, setControlError] = useState('');
  const panelRef = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const run = snapshot.teamRuns.find(row => row.teamRunId === selectedRunId) ?? currentTeamRun(snapshot);
  const tasks = snapshot.tasks.filter(task => task.teamRunId === run?.teamRunId);
  const selectedTask = tasks.find(task => task.taskId === selectedTaskId);
  const selectedMember = snapshot.members.find(member => member.memberId === selectedMemberId);
  const pendingCount = snapshot.interactions.filter(row => row.status === 'pending').length + tasks.filter(task => taskSection(task) === 'attention').length;
  const value = controlledDraft ?? draft;
  function changeDraft(text: string) { setDraft(text); onDraftChange?.(text); }
  function setSelectedTaskId(taskId: string) { setTaskId(taskId); onSelectionChange?.({ teamRunId: run?.teamRunId ?? '', taskId }); }
  function openPanel(next: 'tasks' | 'members') { returnFocus.current = document.activeElement as HTMLElement; setPanel(next); setSelectedMemberId(''); }
  function closePanel() { setPanel(null); setExecutionOpen(false); returnFocus.current?.focus(); }
  function directToMember(member: AgentMember) { setRecipientMemberId(member.memberId); setPanel(null); setExecutionOpen(false); setComposerFocus(value => value + 1); }
  function selectMember(member: AgentMember) { setSelectedSource(undefined); setSelectedMemberId(member.memberId); setPanel('members'); onMemberSelect?.(member); }
  useEffect(() => { if (panel) panelRef.current?.focus(); }, [panel]);
  async function control(action: TeamControlAction) { if (!run || !onControl || controlBusy) return; setControlBusy(true); setControlError(''); try { await onControl(run, action); } catch (cause) { setControlError(cause instanceof Error ? cause.message : '操作失败。'); } finally { setControlBusy(false); } }
  async function acceptRun(accepted: boolean) { if (!run || !onAcceptRun || controlBusy) return; setControlBusy(true); setControlError(''); try { await onAcceptRun(run, accepted); } catch (cause) { setControlError(cause instanceof Error ? cause.message : '验收提交失败。'); } finally { setControlBusy(false); } }
  return <section className="ksadk-teams team-workspace" data-panel={panel || 'closed'} data-execution={executionOpen ? 'open' : 'closed'}>
    <GroupHeader snapshot={snapshot} connection={connection} onProgress={() => openPanel('tasks')} onMembers={() => openPanel('members')} onManage={onManage} />
    {error && <div className="team-top-error" role="alert">{error}{onRetry && <button className="team-text-button" type="button" onClick={onRetry}>重新连接</button>}</div>}
    <div className="team-body"><div className="team-chat-pane" aria-hidden={executionOpen || undefined}>
      <GroupTimeline messages={snapshot.messages}>{run && <TeamProgressCard run={run} tasks={tasks} pendingCount={pendingCount} onOpen={() => openPanel('tasks')} />}</GroupTimeline>
      {pendingCount > 0 && <button type="button" className="team-attention-banner" onClick={() => openPanel('tasks')}>{pendingCount} 项需要处理 <span>查看 <span aria-hidden="true">→</span></span></button>}
      <GroupComposer artifacts={[...new Map([...(snapshot.artifacts || []), ...snapshot.tasks.flatMap(task => task.attempts.flatMap(attempt => attempt.artifacts))].filter(artifact => artifact.source.groupId === snapshot.group.groupId && artifact.source.authorityRef === snapshot.group.authorityRef).map(artifact => [artifact.artifactId, artifact])).values()]} recipientMemberId={recipientMemberId} onRecipientChange={setRecipientMemberId} focusRequest={composerFocus} members={snapshot.members} activeRun={currentTeamRun(snapshot)} value={value} onChange={changeDraft} onSend={onSend} disabled={snapshot.group.status !== 'active'} />
    </div>
    {panel && <aside className="team-sidepanel" ref={panelRef} tabIndex={-1} aria-label={panel === 'tasks' ? '本轮协作' : '团队成员'} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); closePanel(); } }}><header className="team-panel-header"><h2>{panel === 'tasks' ? '本轮协作' : '团队成员'}</h2><button type="button" className="team-button team-icon-button" aria-label="关闭详情" onClick={closePanel}>×</button></header><div className="team-panel-scroll">
      {panel === 'tasks' ? <>{run && <div className="team-run-overview"><TeamStatusLabel status={run.status} /><h3>{run.goal}</h3>{run.reason && <p>{run.reason}</p>}<details className="team-run-budget"><summary>运行限额</summary><dl><div><dt>累计启动</dt><dd>{run.budget.startsUsed} / {run.budget.maxStarts}</dd></div><div><dt>同时执行</dt><dd>最多 {run.budget.maxConcurrent} 个</dd></div>{run.budget.maxTokens && <div><dt>Token</dt><dd>{run.budget.tokensUsed ?? 0} / {run.budget.maxTokens}</dd></div>}{run.budget.maxDurationSeconds && <div><dt>最长运行时间</dt><dd>{Math.round(run.budget.maxDurationSeconds / 60)} 分钟</dd></div>}</dl></details>{onControl && isTeamRunActive(run.status) && <div className="team-run-actions"><button className="team-text-button" type="button" disabled={controlBusy || run.status === 'cancel_requested'} onClick={() => void control(run.dispatchSuspended ? 'resume_dispatch' : 'suspend_dispatch')}>{run.dispatchSuspended ? '继续自动协作' : '暂停自动协作'}</button><button className="team-text-button team-danger" type="button" disabled={controlBusy || run.status === 'cancel_requested'} onClick={() => void control('stop')}>停止本轮</button></div>}{controlError && <p role="alert" className="team-inline-error">{controlError}</p>}</div>}
        {snapshot.teamRuns.length > 1 && <label className="team-field">协作轮次<select value={run?.teamRunId} onChange={event => { setSelectedRunId(event.target.value); setTaskId(''); onSelectionChange?.({ teamRunId: event.target.value, taskId: '' }); }}>{snapshot.teamRuns.map(row => <option key={row.teamRunId} value={row.teamRunId}>{row.goal} · {TEAM_STATUS_LABELS[row.status]}</option>)}</select></label>}
        {run?.status === 'awaiting_acceptance' && onAcceptRun && <section className="team-interaction-card"><span className="team-eyebrow">本轮交付 · 最终验收</span><h3>确认团队交付成果</h3><p>请检查任务结果与交付物，通过后结束本轮协作。</p><div className="team-task-actions"><button className="team-button" type="button" disabled={controlBusy} onClick={() => void acceptRun(false)}>退回修改</button><button className="team-button team-primary" type="button" disabled={controlBusy} onClick={() => void acceptRun(true)}>完成验收</button></div></section>}
        {onRespondInteraction && <TeamInteractionTray interactions={snapshot.interactions} members={snapshot.members} onRespond={onRespondInteraction} />}
        {selectedTask ? <><button className="team-text-button team-back" type="button" onClick={() => setSelectedTaskId('')}>← 所有任务</button><TaskDetail key={selectedTask.taskId} task={selectedTask} members={snapshot.members} onAction={onTaskAction} onOpenArtifact={onOpenArtifact} onMemberSelect={selectMember} /></> : <TaskBoard tasks={tasks} members={snapshot.members} selectedTaskId={selectedTaskId} onSelect={task => setSelectedTaskId(task.taskId)} />}
      </> : selectedMember ? <><button className="team-text-button team-back" type="button" onClick={() => setSelectedMemberId('')}>← 所有成员</button>{renderMember?.(selectedMember, { directedMessage: () => directToMember(selectedMember) }, selectedSource) ?? <MemberInspector member={selectedMember} onDirectedMessage={() => directToMember(selectedMember)} />}</> : <MemberRail members={snapshot.members} selectedMemberId={selectedMemberId} onSelect={selectMember} />}
    </div>{panel === 'tasks' && (tasks.length > 0 || Boolean(onLoadExecution && run)) && <footer className="team-panel-footer"><button className="team-button team-expand" type="button" onClick={() => setExecutionOpen(true)}>展开执行视图 <span aria-hidden="true">↗</span></button></footer>}</aside>}
    {executionOpen && <section className="team-execution-workspace" aria-label="执行工作台"><header className="team-panel-header"><div><span className="team-eyebrow">执行工作台</span><h2>{run?.goal}</h2></div><button className="team-button" type="button" onClick={() => setExecutionOpen(false)}>返回聊天</button></header><Suspense fallback={<div className="team-loading" role="status" aria-label="正在加载执行视图"><span /><span /></div>}><LoadedExecutionTree key={`${snapshot.group.groupId}:${run?.teamRunId || ''}`} authorityRef={snapshot.group.authorityRef} groupId={snapshot.group.groupId} teamRunId={run?.teamRunId || ''} watermark={snapshot.watermark} load={onLoadExecution} tasks={tasks} members={snapshot.members} selectedTaskId={selectedTaskId} onSelect={task => { setSelectedTaskId(task.taskId); setExecutionOpen(false); setPanel('tasks'); }} onSelectNode={node => { if (node.kind === 'task' && node.taskId) { setSelectedTaskId(node.taskId); setPanel('tasks'); setExecutionOpen(false); } else if (node.source) { setSelectedMemberId(node.source.memberId); setSelectedSource(node.source); setPanel('members'); setExecutionOpen(false); } }} /></Suspense></section>}
    </div>
  </section>;
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
