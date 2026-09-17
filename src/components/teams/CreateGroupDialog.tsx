import { useEffect, useId, useRef, useState } from 'react';
import { validateGroupCreate } from '../../core/teams/contracts.js';
import { available, candidateKey, groupTeamCandidates } from '../../core/teams/grouping.js';
import type { ExecutionBinding, GroupCreateInput } from '../../core/teams/types.js';

export type TeamMemberCandidate = { memberId: string; name: string; description?: string; responsibility?: string; binding: ExecutionBinding };
export type CreateGroupDialogProps = { open: boolean; candidates: TeamMemberCandidate[]; serverAuthority?: boolean; loading?: boolean; error?: string; onRefresh?: () => void; onClose: () => void; onCreate: (input: GroupCreateInput) => Promise<unknown> };
/** Selection belongs to the draft, not to a refreshed directory row. */
export function CreateGroupDialog({ open, candidates, serverAuthority, loading, error: directoryError, onRefresh, onClose, onCreate }: CreateGroupDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<TeamMemberCandidate[]>([]);
  const [leader, setLeader] = useState('');
  const [standby, setStandby] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<{ digest: string; idempotencyKey: string } | null>(null);
  const members = selected.map(member => {
    const refreshed = candidates.find(row => row.binding.bindingRef === member.binding.bindingRef);
    return refreshed ? { ...refreshed, memberId: member.memberId, responsibility: member.responsibility } : member;
  });
  const leaderCandidates = members.filter(candidate => candidate.binding.capabilities.leader && available(candidate));
  const actualLeader = leaderCandidates.some(candidate => candidate.memberId === leader) ? leader : leaderCandidates[0]?.memberId ?? '';
  const localLeader = members.find(candidate => candidate.memberId === actualLeader)?.binding.kind === 'local_build';
  const standbyCandidates = candidates.filter(candidate => candidate.binding.kind === 'cloud' && candidate.binding.capabilities.leader && available(candidate));
  const groups = groupTeamCandidates(candidates);
  const visible = groups.filter(versions => versions.some(row => `${row.name} ${row.description || ''} ${row.binding.agentId}`.toLowerCase().includes(query.toLowerCase())));
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previous = document.activeElement as HTMLElement | null;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
    return () => { if (element.open) element.close(); previous?.focus(); };
  }, [open]);
  function select(candidate: TeamMemberCandidate, checked: boolean) {
    setSelected(rows => checked ? [...rows, candidate] : rows.filter(row => candidateKey(row) !== candidateKey(candidate)));
  }
  async function create() {
    if (busy || loading) return;
    setError('');
    const input = { name: name.trim(), members: members.map(member => ({ memberId: member.memberId, name: member.name, bindingRef: member.binding.bindingRef, ...(member.responsibility?.trim() ? { responsibility: member.responsibility.trim() } : {}) })), leaderMemberId: actualLeader, ...(serverAuthority && localLeader && standby ? { leaderStandbyBindingRef: standby } : {}) };
    try {
      validateGroupCreate(input);
      if (members.length < 2) throw new Error('请选择至少 2 位成员，一起组成团队。');
      if (members.some(member => !candidates.some(row => row.binding.bindingRef === member.binding.bindingRef && available(row)))) throw new Error('已选成员中有 Agent 暂不可用，请更换版本或移除后重试。');
      if (!actualLeader) throw new Error('所选成员中至少需要一位支持 Leader 的 Agent。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '团队配置无效。'); return; }
    const digest = JSON.stringify(input);
    if (pending.current?.digest !== digest) pending.current = { digest, idempotencyKey: `group-${globalThis.crypto.randomUUID()}` };
    setBusy(true);
    try { await onCreate({ ...input, idempotencyKey: pending.current.idempotencyKey }); setName(''); setQuery(''); setSelected([]); setLeader(''); setStandby(''); pending.current = null; onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '创建团队失败，已保留你的选择。'); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="ksadk-teams team-create-dialog" aria-labelledby={headingId} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}><form onSubmit={event => { event.preventDefault(); void create(); }}>
    <header><div><span className="team-eyebrow">新的协作空间</span><h2 id={headingId}>组建团队</h2><p>选择搭档，让 Leader 组织分工与复核。</p></div><button type="button" className="team-button team-icon-button" aria-label="关闭创建团队" onClick={onClose} disabled={busy}>×</button></header>
    <div className="team-create-body">
    <label className="team-field">团队名称<input value={name} onChange={event => setName(event.target.value)} placeholder="例如：产品交付团队" maxLength={100} disabled={busy} required /></label>
    <fieldset disabled={busy}><legend>选择成员 <span>{selected.length} / 8</span></legend><div className="team-directory-search"><input aria-label="搜索 Agent" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称或职责" />{onRefresh && <button type="button" className="team-text-button" disabled={loading} onClick={onRefresh}>刷新</button>}</div>
      {loading && <p role="status" className="team-muted">正在读取 Agent…</p>}
      {directoryError && <p role="alert" className="team-inline-error">{directoryError}</p>}
      {!loading && !candidates.length ? <p className="team-muted">还没有 Agent。先创建 Agent 并完成构建，再回来组队。</p> : <div className="team-candidate-list">{visible.map(versions => {
        const chosen = members.find(row => candidateKey(row) === candidateKey(versions[0]));
        const candidate = chosen || versions[0];
        const source = candidate.binding.kind === 'local_build' ? '本地' : '云端';
        const description = candidate.description || candidate.binding.description || (candidate.binding.capabilities.leader ? '可担任 Leader' : '任务成员');
        return <div className="team-candidate-group" key={candidateKey(candidate)}><label className="team-candidate" data-selected={Boolean(chosen)}><input type="checkbox" checked={Boolean(chosen)} disabled={loading || (!chosen && (!available(candidate) || selected.length >= 8))} onChange={event => select(candidate, event.target.checked)} /><span className="team-avatar" aria-hidden="true">{Array.from(candidate.name)[0]}</span><span><strong title={candidate.name}>{candidate.name}</strong><small className="team-candidate-description" title={description}>{description}</small>{!available(candidate) && <small className="team-candidate-reason">{candidate.binding.availability?.reason || '当前不支持团队执行'}</small>}</span><span className="team-source" data-available={available(candidate)} data-state={candidate.binding.availability?.state} title={candidate.binding.availability?.reason || (candidate.binding.availability?.state === "unchecked" ? "创建时检查执行环境" : undefined)}>{source}</span></label>
          {chosen && <details className="team-version-choice"><summary>职责与版本</summary><label className="team-field">工作职责<textarea aria-label={`${candidate.name} 的工作职责`} rows={2} maxLength={2000} value={candidate.responsibility || ''} onChange={event => { const responsibility = event.target.value; setSelected(rows => rows.map(row => candidateKey(row) === candidateKey(candidate) ? { ...row, responsibility } : row)); }} placeholder="例如：核对实现边界，补充测试证据" /></label><p>模型：{candidate.binding.modelName || '沿用固定版本配置'}</p><label className="team-field">执行版本<select aria-label={`${candidate.name} 的执行版本`} value={candidate.binding.bindingRef} onChange={event => { const version = versions.find(row => row.binding.bindingRef === event.target.value)!; setSelected(rows => rows.map(row => candidateKey(row) === candidateKey(candidate) ? { ...version, memberId: row.memberId, responsibility: row.responsibility } : row)); }}>{versions.map(row => <option value={row.binding.bindingRef} key={row.binding.bindingRef} disabled={!available(row)}>{row.binding.version || row.binding.buildId || row.binding.bindingRef}{!available(row) ? ' · 不可用' : ''}</option>)}</select></label></details>}
        </div>;
      })}{!visible.length && !!candidates.length && <p className="team-muted">没有匹配的 Agent。</p>}</div>}
      {selected.filter(member => !candidates.some(row => row.binding.bindingRef === member.binding.bindingRef)).map(member => <p className="team-inline-error" key={member.memberId}>{member.name} · 当前目录中不可用 <button type="button" className="team-text-button" onClick={() => select(member, false)}>移除</button></p>)}
    </fieldset>
    <label className="team-field">指定 Leader<select value={actualLeader} onChange={event => setLeader(event.target.value)} disabled={busy || !leaderCandidates.length}><option value="" disabled>从已选成员中指定</option>{leaderCandidates.map(candidate => <option key={candidate.memberId} value={candidate.memberId}>{candidate.name}</option>)}</select><small>Leader 审核成员成果，你处理工具审批和最终验收。</small></label>
    {serverAuthority && localLeader && <details className="team-version-choice"><summary>本地离线时继续协作</summary><label className="team-field">Leader 云端备用<select value={standby} onChange={event => setStandby(event.target.value)} disabled={busy || loading}><option value="">暂不配置</option>{standbyCandidates.map(candidate => <option key={candidate.binding.bindingRef} value={candidate.binding.bindingRef}>{candidate.name} · {candidate.binding.version || candidate.binding.buildId || '固定版本'}</option>)}</select></label><p className="team-muted">创建前会检查同版本执行能力。云端模型、工具和任务资料需预先准备；本地凭据不会复制到云端。</p>{!standbyCandidates.length && <p className="team-muted">还没有可用的云端 Leader 节点。可以先创建团队，接入节点后在任务详情配置。</p>}</details>}
    <p className="team-create-footnote">创建时检查选中成员的执行环境；配置失败会保留草稿。</p>
    {error && <p role="alert" className="team-inline-error">{error}</p>}
    </div>
    <footer><button type="button" className="team-button" onClick={onClose} disabled={busy}>稍后继续</button><button type="submit" className="team-button team-primary" disabled={busy || loading || members.length < 2}>{busy ? '正在检查并创建…' : '创建团队'}</button></footer>
  </form></dialog>;
}
