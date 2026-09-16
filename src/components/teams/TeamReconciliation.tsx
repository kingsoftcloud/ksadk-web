import { useState } from 'react';
import type { TeamReconciliationRecord, TeamRun } from '../../core/teams/types.js';

export type ReconciliationActions = {
  onLoadReconciliation?: (run: TeamRun) => Promise<TeamReconciliationRecord[]>;
  onReconcile?: (record: TeamReconciliationRecord, action: 'confirm_ended' | 'use_result', reason: string) => Promise<unknown>;
};

export function TeamReconciliation({ run, onLoadReconciliation: load, onReconcile: reconcile }: ReconciliationActions & { run: TeamRun }) {
  const [records, setRecords] = useState<TeamReconciliationRecord[] | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!load || !reconcile || run.leaderStandby?.reason !== 'execution_uncertain_fenced') return null;
  async function refresh() {
    setBusy(true); setError('');
    try { setRecords(await load!(run)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '暂时无法读取原单。'); }
    finally { setBusy(false); }
  }
  async function confirm(record: TeamReconciliationRecord, action: 'confirm_ended' | 'use_result') {
    setBusy(true); setError('');
    try { await reconcile!(record, action, (reasons[record.commandId] || '').trim()); setRecords(await load!(run)); setReasons(current => ({ ...current, [record.commandId]: '' })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '核查状态已改变，请刷新。'); }
    finally { setBusy(false); }
  }
  return <section className="team-run-budget" aria-label="原执行核查">
    <h4>旧执行结果需要核查</h4>
    <p>云端已接管，相关分支会等待原单确认。请先核对外部操作和交付物，再决定是否采用结果。</p>
    <button type="button" className="team-button" disabled={busy} onClick={() => void refresh()}>{busy ? '正在核对…' : '查看原单证据'}</button>
    {records?.filter(record => !record.reconciled).map(record => {
      const receipt = record.quarantinedReceipt;
      const reason = reasons[record.commandId] || '';
      const ended = !!record.receiptDigest && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(receipt?.run_status || '');
      return <article className="team-observer-item" key={record.commandId}>
        <p>{record.taskId ? '成员执行' : '原 Leader 执行'} · {ended ? '已返回结束回执' : '原节点尚未返回结束回执'}</p>
        {receipt?.output && <pre className="team-observer-details">{receipt.output.slice(0, 10000)}</pre>}
        <details><summary>执行引用</summary><code>{receipt?.run_id || record.nativeRunId || record.commandId}</code></details>
        {ended && <><label className="team-field">核查说明<textarea value={reason} onChange={event => setReasons(current => ({ ...current, [record.commandId]: event.target.value }))} maxLength={2000} placeholder="说明已检查哪些原单或外部结果" /></label>
          <button type="button" className="team-button" disabled={busy || !reason.trim()} onClick={() => void confirm(record, 'confirm_ended')}>确认已结束</button>
          {record.taskId && receipt?.run_status === 'succeeded' && <button type="button" className="team-button" disabled={busy || !reason.trim()} onClick={() => void confirm(record, 'use_result')}>采用已验证成果</button>}
          <p className="team-muted">确认结束不会自动重新执行；必要时再对相应子任务提出重试。</p></>}
      </article>;
    })}
    {error && <p role="alert" className="team-inline-error">{error}</p>}
  </section>;
}
