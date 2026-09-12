import { useState } from 'react';
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
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between text-sm"
      >
        <span>{agent?.name || 'Remote agent'}</span>
        <span role="status">{status}</span>
      </button>
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
                Cancel remote agent
              </button>
            )}
        </div>
      )}
    </section>
  );
}
