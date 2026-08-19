import { InteractionOutcomeLabel } from './InteractionTray';
import type { Interaction } from '../../core/interaction/types.js';

function formatTime(value: string | null): string {
  if (!value) return '';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString();
}

/**
 * Read-only anchor for a resolved interaction in chat history.
 * Replaces historical interactive buttons: it retains the actor,
 * decision time, outcome, and a redacted response summary — nothing
 * clickable.
 */
export function InteractionHistoryAnchor({ interaction }: { interaction: Interaction }) {
  const terminal =
    interaction.status === 'resolved'
    || interaction.status === 'cancelled'
    || interaction.status === 'expired';

  return (
    <div
      data-testid="interaction-history-anchor"
      data-interaction-id={interaction.interactionId}
      data-interaction-status={interaction.status}
      className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-300"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-700 dark:text-slate-200">{interaction.title}</span>
        <InteractionOutcomeLabel outcome={interaction.outcome || interaction.status} />
      </div>
      {terminal ? (
        <div className="mt-1 leading-relaxed">
          {interaction.actor ? <span>操作人：{interaction.actor} · </span> : null}
          {interaction.resolvedAt ? <span>决定时间：{formatTime(interaction.resolvedAt)} · </span> : null}
          <span data-testid="interaction-history-response-summary">
            {interaction.responseSummary || '响应内容已脱敏'}
          </span>
        </div>
      ) : (
        <div className="mt-1">
          状态：{interaction.status === 'pending' ? '待处理（见输入区确认面板）' : '处理中…'}
        </div>
      )}
    </div>
  );
}
