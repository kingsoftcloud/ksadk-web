import { useEffect, useState } from 'react';
import type { Message } from './types.js';
import type {
  AgentBlockActions,
  AgentScopeAction,
} from '../../core/conversation/agent.js';
import { ProcessingBlocksView } from './ProcessingBlocksView.js';
import { MessageMarkdown } from '../MessageMarkdown.js';
export type AgentBlockViewProps = {
  block: NonNullable<Message['agentBlock']>;
  actions?: AgentBlockActions;
};
const STATUS_LABELS: Record<string, string> = {
  submitted: '已提交',
  working: '正在处理',
  input_required: '等待输入',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
};

function elapsedLabel(start: unknown, end: unknown): string | undefined {
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start
  )
    return undefined;
  const seconds = Math.floor(end - start);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/** One remote level. Children reuse trusted local renderers; nested delegation stays passive. */
export function AgentBlockView({ block, actions }: AgentBlockViewProps) {
  const [open, setOpen] = useState(false);
  const d = block.item.payload;
  const agent = d.agent as { name?: string } | undefined;
  const cancel = d.cancel as
    | { capability?: string; request_state?: string }
    | undefined;
  const status = String(d.status || 'submitted');
  const active = ['submitted', 'working', 'input_required'].includes(status);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (
      !active ||
      typeof d.started_at !== 'number' ||
      !Number.isFinite(d.started_at)
    )
      return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, d.started_at]);
  const elapsed = elapsedLabel(d.started_at, active ? now / 1000 : d.ended_at);
  const action: AgentScopeAction = {
    sessionId: block.item.sessionId,
    runId: block.item.runId,
    scopeId: String(d.scope_id),
    parentItemId: block.item.parentItemId || '',
  };
  return (
    <section
      data-testid="agent-block"
      className="mb-3 rounded border border-slate-200 p-3 dark:border-slate-700"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={agent?.name || '远程智能体'}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between text-sm"
      >
        <span>{agent?.name || '远程智能体'}</span>
        <span className="flex items-center gap-2">
          {elapsed && (
            <span
              data-testid="agent-block-elapsed"
              className="text-xs text-slate-500"
              aria-label={`耗时 ${elapsed}`}
            >
              {elapsed}
            </span>
          )}
          <span role="status">{STATUS_LABELS[status] || '状态未知'}</span>
        </span>
      </button>
      {block.summary && (
        <p
          data-testid="agent-block-summary"
          className="mt-1 line-clamp-2 text-xs text-slate-500"
        >
          {block.summary}
        </p>
      )}
      {open && (
        <div className="mt-3 space-y-2" data-testid="agent-block-detail">
          {block.messages.map((message) => (
            <div key={message.id}>
              {message.blocks?.length ? (
                <ProcessingBlocksView message={message} isStreaming={active} />
              ) : (
                <MessageMarkdown content={message.content} />
              )}
              {message.attachments?.map((a) => (
                <a key={a.url} href={a.url} rel="noreferrer" target="_blank">
                  {a.name}
                </a>
              ))}
            </div>
          ))}
          {active &&
            actions?.cancel &&
            cancel?.capability === 'supported' &&
            cancel.request_state === 'none' && (
              <button
                type="button"
                onClick={() => void actions.cancel?.(action)}
              >
                取消远程智能体
              </button>
            )}
        </div>
      )}
    </section>
  );
}
