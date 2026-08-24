import { InteractionOutcomeLabel } from './InteractionTray';
import type { Interaction } from '../../core/interaction/types.js';

function formatTime(value: string | null): string {
  if (!value) return '';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString();
}

/**
 * Top-level keys of the interaction's request_schema, shown as a short
 * read-only summary of what was asked. Never renders raw values.
 */
function requestSchemaKeys(
  schema: Record<string, unknown> | null,
): string[] {
  const props = schema?.properties;
  if (typeof props !== 'object' || props === null) return [];
  return Object.keys(props as Record<string, unknown>);
}

/**
 * Read-only anchor for a resolved interaction in chat history.
 * Replaces historical interactive buttons: it retains the actor,
 * decision time, outcome, and a redacted response summary, and expands
 * into a fixed read-only snapshot (native details/summary — no buttons,
 * no inputs, nothing editable).
 */
export function InteractionHistoryAnchor({ interaction }: { interaction: Interaction }) {
  const terminal =
    interaction.status === 'resolved'
    || interaction.status === 'cancelled'
    || interaction.status === 'expired';
  const schemaKeys = requestSchemaKeys(interaction.requestSchema);

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
        <>
          <div className="mt-1 leading-relaxed">
            {interaction.actor ? <span>操作人：{interaction.actor} · </span> : null}
            {interaction.resolvedAt ? <span>决定时间：{formatTime(interaction.resolvedAt)} · </span> : null}
            <span data-testid="interaction-history-response-summary">
              {interaction.responseSummary || '响应内容已脱敏'}
            </span>
          </div>
          <details data-testid="interaction-history-detail" className="mt-1">
            <summary className="cursor-pointer select-none text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">
              查看确认快照
            </summary>
            <div
              data-testid="interaction-history-snapshot"
              className="mt-1 rounded border border-slate-200 bg-white px-2 py-1.5 leading-relaxed dark:border-slate-800 dark:bg-slate-950"
            >
              <div>
                操作者：<span data-testid="interaction-history-actor-ref">{interaction.actor || '—'}</span>
              </div>
              <div>
                决定时间：{formatTime(interaction.resolvedAt) || '—'}
              </div>
              <div>
                关键参数：
                {schemaKeys.length > 0 ? (
                  <span data-testid="interaction-history-schema-keys">{schemaKeys.join('、')}</span>
                ) : (
                  <span>无结构化参数</span>
                )}
              </div>
            </div>
          </details>
        </>
      ) : (
        <div className="mt-1">
          状态：{interaction.status === 'pending' ? '待处理（见输入区确认面板）' : '处理中…'}
        </div>
      )}
    </div>
  );
}
