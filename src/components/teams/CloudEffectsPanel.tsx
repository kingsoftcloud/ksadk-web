import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CloudEffect } from '../../core/teams/cloudEffects.js';
import type { HttpCloudTeamsProductClient } from '../../core/teams/cloudProductClient.js';
import type { TeamsOperationPayload } from '../../core/teams/operationOutbox.js';
import { workspaceClientScopeKey, type WorkspaceClientScope } from '../../core/teams/workspaceContracts.js';

export interface CloudEffectsPanelProps {
  scope: WorkspaceClientScope; teamRunId: string; product: HttpCloudTeamsProductClient;
  canWrite: boolean; refreshKey: string; pendingEffectKeys: string[];
  command: (suffix: string, payload: TeamsOperationPayload) => Promise<unknown>;
}

/** Owner review never infers external completion or mutates a native run. */
export function CloudEffectsPanel({ scope, teamRunId, product, canWrite, refreshKey, pendingEffectKeys, command }: CloudEffectsPanelProps) {
  const [items, setItems] = useState<CloudEffect[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false); const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [review, setReview] = useState<{ effect: CloudEffect; evidenceRef: string } | null>(null);
  const [reason, setReason] = useState(''); const [accepted, setAccepted] = useState(false);
  const [saving, setSaving] = useState(false); const [saveError, setSaveError] = useState('');
  const controller = useRef<AbortController | null>(null); const generation = useRef(0);
  const formRef = useRef<HTMLFormElement>(null);
  const identity = workspaceClientScopeKey(scope); const fieldId = useId();
  const load = useCallback(async (after = 0) => {
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    const epoch = ++generation.current; setLoading(true); setError('');
    try {
      const page = await product.effects(scope, teamRunId, current.signal, after);
      if (current.signal.aborted || epoch !== generation.current) return;
      setItems(previous => after ? [...previous.filter(row => !page.items.some(item => item.effectKey === row.effectKey)), ...page.items] : page.items);
      setCursor(page.nextCursor); setLoaded(true);
    } catch { if (!current.signal.aborted && epoch === generation.current) setError('执行记录读取失败，请重试。当前不能据此判断外部操作是否完成。'); }
    finally { if (!current.signal.aborted && epoch === generation.current) setLoading(false); }
  }, [identity, teamRunId, product]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); return () => controller.current?.abort(); }, [load, refreshKey]);
  useEffect(() => { if (review) formRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [review?.effect.effectKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const latest = review ? items.find(row => row.effectKey === review.effect.effectKey) : undefined;
  const changed = Boolean(review && loaded && (!latest || latest.revision !== review.effect.revision || latest.evidenceDigest !== review.effect.evidenceDigest));
  const pending = Boolean(review && pendingEffectKeys.includes(review.effect.effectKey));
  async function submit() {
    if (!review || !canWrite || error || loading || saving || changed || pending || !accepted || !reason.trim()) return;
    setSaving(true); setSaveError('');
    try {
      await command(`effects/${review.effect.effectKey}/reconcile`, {
        expectedRevision: review.effect.revision, expectedEvidenceDigest: review.effect.evidenceDigest,
        decision: 'accept_risk', evidenceRef: review.evidenceRef, reason: reason.trim(),
      });
      setReview(null); setReason(''); setAccepted(false); void load();
    } catch (cause) { setSaveError(cause instanceof Error ? cause.message : '核查决定尚未确认，请核对原单。'); void load(); }
    finally { setSaving(false); }
  }
  return <section className="team-effect-review" aria-label="外部操作核查">
    <header className="team-effect-review-header"><div><h3>外部操作核查</h3><p className="team-muted">结果未确认的操作需要核查后再继续。核查决定会保留记录。</p></div><button type="button" className="team-button" disabled={loading} onClick={() => void load()}>刷新记录</button></header>
    {error && <p role="alert" className="team-inline-error">{error}</p>}
    {loading && <p role="status" className="team-muted">正在读取原执行记录…</p>}
    {loaded && !loading && !error && !items.length && <p className="team-muted">{cursor ? '这一页没有待核查操作，请继续读取后续记录。' : '当前任务没有待核查的外部操作。'}</p>}
    {items.map(row => <article className="team-effect-card" key={row.effectKey}>
      <div><strong>{row.toolName}</strong><span className="team-effect-state">{row.resolutionConflict ? '核查后收到不同证据' : row.phase === 'prepared' ? '执行结果待核对' : '外部结果未确认'}</span></div>
      <p className="team-muted">{row.resolutionConflict ? '新证据与已有核查决定不一致，后续处理保持暂停。请重新核对原记录，并记录新的决定。' : '系统保留了原操作，不会因断线或重启自动重复发送。请先查看外部系统。'}</p>
      {row.outcome?.evidence_ref && <p className="team-muted">原执行证据：{row.outcome.evidence_ref}</p>}
      <button type="button" className="team-button" disabled={!canWrite || Boolean(error) || saving || pendingEffectKeys.includes(row.effectKey)} onClick={() => { setReview({ effect: row, evidenceRef: `manual-review:${crypto.randomUUID()}` }); setReason(''); setAccepted(false); setSaveError(''); }}>{pendingEffectKeys.includes(row.effectKey) ? '等待核对原单' : '记录核查决定'}</button>
    </article>)}
    {cursor !== null && <button className="team-button team-history-more" type="button" disabled={loading} onClick={() => void load(cursor)}>更多执行记录</button>}
    {review && <form ref={formRef} className="team-effect-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <h3>核查 {review.effect.toolName}</h3>
      <p className="team-muted">此操作记录你接受剩余不确定性的决定，不会重新调用外部工具，也不会将原执行标记为成功。</p>
      <label className="team-field" htmlFor={fieldId}>核查说明<textarea id={fieldId} value={reason} maxLength={1000} rows={3} disabled={saving || pending} onChange={event => setReason(event.target.value)} placeholder="说明查验了什么、得到什么结果，以及继续处理的依据。" /></label>
      <label className="team-effect-consent"><input type="checkbox" checked={accepted} disabled={saving || pending} onChange={event => setAccepted(event.target.checked)} /><span>我已核对外部记录，接受剩余不确定性并允许后续处理。</span></label>
      {changed && <p role="alert">记录已更新，核查说明已保留。{latest && <button type="button" className="team-text-button" onClick={() => { setReview({ ...review, effect: latest }); setAccepted(false); }}>读取最新证据后重新核对</button>}</p>}
      {pending && <p role="status">决定已保存在本地，服务端接收结果仍待确认。请在操作记录中核对原单。</p>}
      {saveError && <p role="alert" className="team-inline-error">{saveError}</p>}
      <div className="team-task-actions"><button type="button" className="team-button" disabled={saving} onClick={() => setReview(null)}>收起</button><button type="submit" className="team-button team-primary" disabled={!canWrite || Boolean(error) || loading || saving || changed || pending || !accepted || !reason.trim()}>{saving ? '正在记录…' : '记录核查决定'}</button></div>
    </form>}
  </section>;
}
