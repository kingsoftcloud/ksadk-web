import { useEffect, useId, useRef, useState } from 'react';
import { validateGroupCreate } from '../../core/teams/contracts.js';
import type { ExecutionBinding, GroupCreateInput } from '../../core/teams/types.js';

export type TeamMemberCandidate = { memberId: string; name: string; description?: string; binding: ExecutionBinding };
export type CreateGroupDialogProps = { open: boolean; candidates: TeamMemberCandidate[]; loading?: boolean; onClose: () => void; onCreate: (input: GroupCreateInput) => Promise<unknown> };

export function CreateGroupDialog({ open, candidates, loading, onClose, onCreate }: CreateGroupDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const nameId = useId();
  const leaderId = useId();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [leader, setLeader] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<{ digest: string; idempotencyKey: string } | null>(null);
  const members = candidates.filter(candidate => selected.includes(candidate.memberId));
  const leaderCandidates = members.filter(candidate => candidate.binding.capabilities.leader);
  const actualLeader = leaderCandidates.some(candidate => candidate.memberId === leader) ? leader : leaderCandidates[0]?.memberId ?? '';
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previous = document.activeElement as HTMLElement | null;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
    return () => { if (element.open) element.close(); previous?.focus(); };
  }, [open]);
  async function create() {
    if (busy) return;
    setError('');
    const input = { name: name.trim(), members: members.map(member => ({ memberId: member.memberId, name: member.name, bindingRef: member.binding.bindingRef })), leaderMemberId: actualLeader };
    try { validateGroupCreate(input); if (!actualLeader) throw new Error('所选成员中至少需要一位支持 Leader 的 Agent。'); } catch (cause) { setError(cause instanceof Error ? cause.message : '群组配置无效。'); return; }
    const digest = JSON.stringify(input);
    if (pending.current?.digest !== digest) pending.current = { digest, idempotencyKey: `group-${globalThis.crypto.randomUUID()}` };
    setBusy(true);
    try { await onCreate({ ...input, idempotencyKey: pending.current.idempotencyKey }); setName(''); setSelected([]); setLeader(''); pending.current = null; onClose(); } catch (cause) { setError(cause instanceof Error ? cause.message : '创建群组失败。'); } finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="ksadk-teams team-create-dialog" aria-labelledby={headingId} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}><form onSubmit={event => { event.preventDefault(); void create(); }}><header><div><span className="team-eyebrow">AGENT TEAMS</span><h2 id={headingId}>创建团队</h2><p>选择搭档，给团队一个共同目标。</p></div><button type="button" className="team-button team-icon-button" aria-label="关闭创建团队" onClick={onClose} disabled={busy}>×</button></header>
    <fieldset disabled={busy || loading}><legend>选择成员 <span>{selected.length} / 8</span></legend>{loading ? <p role="status">正在读取可用 Agent…</p> : !candidates.length ? <p className="team-muted">暂无可调用的 Agent。请先创建并构建 Agent。</p> : <div className="team-candidate-list">{candidates.map(candidate => <label key={candidate.memberId} className="team-candidate" data-selected={selected.includes(candidate.memberId)}><input type="checkbox" checked={selected.includes(candidate.memberId)} disabled={!candidate.binding.capabilities.enqueue || (!selected.includes(candidate.memberId) && selected.length >= 8)} onChange={event => setSelected(value => event.target.checked ? [...value, candidate.memberId] : value.filter(id => id !== candidate.memberId))} /><span className="team-avatar" aria-hidden="true">{Array.from(candidate.name)[0]}</span><span><strong>{candidate.name}</strong><small>{candidate.description || (candidate.binding.capabilities.leader ? '可担任 Leader' : '任务成员')}{!candidate.binding.capabilities.enqueue ? ' · 当前不可调用' : ''}</small></span></label>)}</div>}</fieldset>
    <label className="team-field" htmlFor={nameId}>群组名称<input id={nameId} value={name} onChange={event => setName(event.target.value)} placeholder="例如：接口改造协作组" maxLength={100} disabled={busy} required /></label><label className="team-field" htmlFor={leaderId}>指定 Leader<select id={leaderId} value={actualLeader} onChange={event => setLeader(event.target.value)} disabled={busy || !leaderCandidates.length}><option value="" disabled>从已选成员中指定</option>{leaderCandidates.map(candidate => <option key={candidate.memberId} value={candidate.memberId}>{candidate.name}</option>)}</select><small>Leader 负责分工与汇总，审批和最终验收仍由你决定。</small></label>
    {error && <p role="alert" className="team-inline-error">{error}</p>}<footer><button type="button" className="team-button" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="team-button team-primary" disabled={busy || loading || !members.length}>{busy ? '正在创建' : '创建团队'}</button></footer></form></dialog>;
}
