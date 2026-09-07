import { useState } from 'react';
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  MessageCircleQuestion,
  Pencil,
  X,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import type {
  Interaction,
  InteractionAction,
} from '../../core/interaction/types.js';
import {
  validateA2uiPresentation,
  type A2uiRenderMode,
} from '../../core/interaction/a2ui-validate.js';
import { interactionIdempotencyKey } from '../../core/interaction/types.js';
import { InteractionSchemaForm } from './InteractionSchemaForm';
import { InteractionA2uiSurface } from './InteractionA2uiSurface';

export type InteractionTrayRespondInput = {
  interactionId: string;
  expectedRevision: number;
  action: InteractionAction;
  response: Record<string, unknown>;
  idempotencyKey: string;
};

export type InteractionTrayProps = {
  /** Pending (and in-flight) interactions for the current session. */
  interactions: readonly Interaction[];
  activeIndex: number;
  onSelectIndex: (index: number) => void;
  onRespond: (input: InteractionTrayRespondInput) => void | Promise<unknown>;
  /** Local pinned A2UI catalog used for digest validation. */
  localCatalog?: unknown;
  className?: string;
};

function firstA2uiInputSchema(
  a2ui: { messages: Array<Record<string, unknown>> } | null | undefined,
): Record<string, unknown> | null {
  for (const message of a2ui?.messages || []) {
    const schema =
      message.inputSchema ?? message.input_schema ?? message.schema;
    if (typeof schema === 'object' && schema !== null) {
      return schema as Record<string, unknown>;
    }
  }
  return null;
}

function isExpired(interaction: Interaction): boolean {
  if (!interaction.expiresAt) return false;
  const expiry = Date.parse(interaction.expiresAt);
  return Number.isFinite(expiry) && expiry <= Date.now();
}

/**
 * A definitive submit rejection (e.g. first-wins interaction_already_resolved
 * from another tab). The receipt never carries a terminal Interaction fact —
 * only the SessionEvent does — so this is shown as a failed submit, never
 * as resolved/cancelled.
 */
function readSubmitError(
  interaction: Interaction,
): { code: string; message: string; retryable: boolean } | null {
  const error = interaction.extensions.submit_error;
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && 'message' in error
  ) {
    return {
      code: String(error.code),
      message: String(error.message),
      retryable: Boolean('retryable' in error && error.retryable),
    };
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  const direct = asRecord(value);
  if (direct) return direct;
  if (typeof value !== 'string') return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function shortText(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(' ');
  return typeof value === 'string' ? value : '';
}

function approvalSummary(interaction: Interaction): {
  operation: string;
  command: string;
  reason: string;
  cwd: string;
} {
  const detail = parseRecord(interaction.extensions.detail);
  const args = parseRecord(interaction.extensions.arguments);
  const source = detail || args || {};
  const rawOperation = interaction.title.replace(/^审批[：:]\s*/, '').trim();
  const operation = ({
    command_execution: '命令执行',
    file_change: '文件修改',
    mcp_tool_call: 'MCP 工具调用',
  } as Record<string, string>)[rawOperation] || rawOperation;
  return {
    operation,
    command: shortText(source.command ?? source.cmd),
    reason: shortText(source.reason ?? source.justification),
    cwd: shortText(source.cwd ?? source.workdir),
  };
}

const OUTCOME_LABEL: Record<string, string> = {
  approved: '已同意',
  rejected: '已拒绝',
  submitted: '已提交',
  cancelled: '已取消',
  expired: '已过期',
};

export function InteractionTray({
  interactions,
  activeIndex,
  onSelectIndex,
  onRespond,
  localCatalog,
  className,
}: InteractionTrayProps) {
  const [comment, setComment] = useState('');
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});

  const active = interactions[Math.min(activeIndex, Math.max(interactions.length - 1, 0))];
  if (!active) return null;

  const expired = isExpired(active);
  const submitError = readSubmitError(active);
  const summary = approvalSummary(active);
  const disabled = expired || active.status === 'resolving';
  const presentationMode = validateA2uiPresentation(
    active.presentation?.a2ui,
    localCatalog,
  );
  // The canonical JSON schema form is also the safe fallback whenever the
  // A2UI presentation cannot be validated: the schema comes from the
  // interaction's request_schema, or from the A2UI message payload.
  const fallbackSchema =
    active.requestSchema
    ?? firstA2uiInputSchema(active.presentation?.a2ui)
    ?? null;
  const mode: A2uiRenderMode =
    active.kind === 'approval'
      ? 'basic-controls'
      : presentationMode === 'a2ui'
        ? 'a2ui'
      : presentationMode === 'json-schema-form' && fallbackSchema
        ? 'json-schema-form'
        : active.requestSchema && !active.presentation
          ? 'json-schema-form'
          : 'basic-controls';
  const schemaForForm =
    mode === 'json-schema-form'
      ? fallbackSchema || active.requestSchema
      : active.requestSchema;

  const respond = (action: InteractionAction, response: Record<string, unknown>) => {
    if (disabled) return;
    void Promise.resolve(
      onRespond({
        interactionId: active.interactionId,
        expectedRevision: active.revision,
        action,
        response,
        idempotencyKey: interactionIdempotencyKey(active.interactionId, active.revision),
      }),
    ).catch(() => {
      // InteractionClient already records a retryable submit error in the
      // shared store. Avoid an unhandled rejection from a click handler.
    });
  };

  return (
    <div
      data-testid="interaction-tray"
      data-slot="interaction-tray"
      data-ui="interaction-tray"
      data-interaction-status={active.status}
      data-interaction-count={interactions.length}
      className={cn('mx-auto mb-2 w-full max-w-[64rem] px-3 sm:px-4', className)}
    >
      <div
        data-slot="interaction-card"
        className="rounded-2xl border border-[var(--ksadk-interaction-border)] bg-[var(--ksadk-interaction-background)] px-3 py-3 text-[var(--ksadk-interaction-foreground)] shadow-sm"
      >
        <div className="flex items-center justify-between gap-2 text-xs text-[var(--ksadk-interaction-muted)]">
          <div className="flex min-w-0 items-center gap-1.5">
            <MessageCircleQuestion className="h-3.5 w-3.5 shrink-0" strokeWidth={1.7} aria-hidden="true" />
            <span data-testid="interaction-tray-title">
              {active.kind === 'approval' ? '问题' : active.title}
            </span>
            {summary.operation ? (
              <span className="truncate text-[11px] text-[var(--ksadk-interaction-muted)]">
                {summary.operation}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            {interactions.length > 1 ? (
              <>
              <button
                type="button"
                data-testid="interaction-tray-prev"
                disabled={activeIndex <= 0}
                onClick={() => onSelectIndex(Math.max(activeIndex - 1, 0))}
                className="rounded p-1 transition hover:bg-[var(--ksadk-interaction-muted-background)] disabled:opacity-30"
                aria-label="上一条待确认"
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <span data-testid="interaction-tray-count" className="min-w-10 text-center">
                {activeIndex + 1} of {interactions.length}
              </span>
              <button
                type="button"
                data-testid="interaction-tray-next"
                disabled={activeIndex >= interactions.length - 1}
                onClick={() => onSelectIndex(Math.min(activeIndex + 1, interactions.length - 1))}
                className="rounded p-1 transition hover:bg-[var(--ksadk-interaction-muted-background)] disabled:opacity-30"
                aria-label="下一条待确认"
              >
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              </>
            ) : null}
            <button
              type="button"
              data-testid="interaction-cancel"
              disabled={disabled}
              onClick={() => respond('cancel', {})}
              className="rounded p-1 transition hover:bg-[var(--ksadk-interaction-muted-background)] hover:text-[var(--ksadk-interaction-foreground)] disabled:opacity-30"
              aria-label="取消本次确认"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {active.message !== summary.command ? (
          <p className="mt-2 whitespace-pre-wrap break-words text-sm font-medium leading-5 text-[var(--ksadk-interaction-foreground)]" data-testid="interaction-tray-message">
            {active.message}
          </p>
        ) : null}

        {summary.command || summary.reason || summary.cwd ? (
          <div
            data-slot="interaction-summary"
            className="mt-1.5 space-y-1 rounded-xl bg-[var(--ksadk-interaction-muted-background)] px-2.5 py-2 text-xs leading-5"
          >
            {summary.command ? (
              <code className="block max-h-12 overflow-auto whitespace-pre-wrap break-all font-mono text-[var(--ksadk-interaction-foreground)]">
                {summary.command}
              </code>
            ) : null}
            {summary.reason ? (
              <p className="text-[var(--ksadk-interaction-muted)]">{summary.reason}</p>
            ) : null}
            {summary.cwd ? (
              <p className="truncate font-mono text-[11px] text-[var(--ksadk-interaction-muted)]" title={summary.cwd}>
                {summary.cwd}
              </p>
            ) : null}
          </div>
        ) : null}

        {expired ? (
          <p className="mt-2 text-xs font-medium text-rose-600 dark:text-rose-400" data-testid="interaction-tray-expired">
            该确认已过期（{OUTCOME_LABEL.expired}），等待运行时继续处理。
          </p>
        ) : null}

        {submitError ? (
          <p className="mt-2 text-xs font-medium text-rose-600 dark:text-rose-400" data-testid="interaction-tray-error">
            提交失败（{submitError.code}）：{submitError.message}
            {submitError.retryable ? '，可重试。' : ''}
          </p>
        ) : null}

        {mode === 'a2ui' && active.presentation?.a2ui ? (
          <InteractionA2uiSurface
            a2ui={active.presentation.a2ui}
            disabled={disabled}
            onSubmit={(payload) => respond('submit', payload)}
            onCancel={() => respond('cancel', {})}
          />
        ) : mode === 'json-schema-form' && schemaForForm ? (
          <InteractionSchemaForm
            schema={schemaForForm}
            values={formValues}
            onChange={setFormValues}
            disabled={disabled}
            onSubmit={() => respond('submit', formValues)}
            onCancel={() => respond('cancel', {})}
          />
        ) : active.kind === 'approval' ? (
          <div className="mt-2 flex flex-col gap-1" data-testid="interaction-tray-basic">
            <button
              type="button"
              data-testid="interaction-approve"
              disabled={disabled}
              onClick={() => respond('approve', { decision: 'approve' })}
              className="group flex min-h-9 w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left text-sm font-medium text-[var(--ksadk-interaction-foreground)] transition hover:bg-[var(--ksadk-interaction-muted-background)] disabled:cursor-not-allowed disabled:opacity-55"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--ksadk-interaction-muted-background)] text-xs text-[var(--ksadk-interaction-muted)]">1</span>
              <span className="min-w-0 flex-1">批准并继续</span>
              <ArrowRight className="h-3.5 w-3.5 text-[var(--ksadk-interaction-muted)] opacity-0 transition group-hover:opacity-100" aria-hidden="true" />
            </button>
            <button
              type="button"
              data-testid="interaction-reject"
              disabled={disabled}
              onClick={() => respond('reject', { decision: 'reject' })}
              className="group flex min-h-9 w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left text-sm font-medium text-[var(--ksadk-interaction-foreground)] transition hover:bg-[var(--ksadk-interaction-muted-background)] disabled:cursor-not-allowed disabled:opacity-55"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--ksadk-interaction-muted-background)] text-xs text-[var(--ksadk-interaction-muted)]">2</span>
              <span className="min-w-0 flex-1">拒绝</span>
              <ArrowRight className="h-3.5 w-3.5 text-[var(--ksadk-interaction-muted)] opacity-0 transition group-hover:opacity-100" aria-hidden="true" />
            </button>
            <label className="mt-0.5 flex min-w-0 items-center gap-2.5 rounded-xl bg-[var(--ksadk-interaction-muted-background)]/60 px-2.5 py-1.5">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--ksadk-interaction-border)] bg-[var(--ksadk-interaction-control-background)] text-[var(--ksadk-interaction-muted)]">
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
              <input
                type="text"
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key !== 'Enter'
                    || event.nativeEvent.isComposing
                    || !comment.trim()
                  ) return;
                  event.preventDefault();
                  respond('cancel', { feedback: comment.trim() });
                }}
                placeholder="告诉 Agent 要如何修改"
                disabled={disabled}
                data-testid="interaction-tray-comment"
                className="h-8 min-w-0 flex-1 border-0 bg-transparent px-0 text-sm font-medium text-[var(--ksadk-interaction-foreground)] outline-none placeholder:text-[var(--ksadk-interaction-muted)] disabled:cursor-not-allowed disabled:opacity-55"
              />
              <button
                type="button"
                data-testid="interaction-feedback-submit"
                aria-label="提交修改意见"
                disabled={disabled || !comment.trim()}
                onClick={() => respond('cancel', { feedback: comment.trim() })}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--ksadk-interaction-muted)] transition hover:bg-[var(--ksadk-interaction-control-background)] hover:text-[var(--ksadk-interaction-foreground)] disabled:opacity-30"
              >
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </label>
          </div>
        ) : (
          <div className="mt-2.5" data-testid="interaction-tray-basic">
            <input
              type="text"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key !== 'Enter'
                  || event.nativeEvent.isComposing
                  || !comment.trim()
                ) return;
                event.preventDefault();
                respond('submit', { value: comment.trim() });
              }}
              placeholder="输入回复"
              disabled={disabled}
              data-testid="interaction-tray-comment"
              className="mb-2 h-8 w-full rounded-lg border border-[var(--ksadk-interaction-border)] bg-[var(--ksadk-interaction-control-background)] px-2.5 text-sm text-[var(--ksadk-interaction-foreground)] outline-none placeholder:text-[var(--ksadk-interaction-muted)] focus:ring-1 focus:ring-[var(--ksadk-interaction-focus-ring)]"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                data-testid="interaction-submit"
                disabled={disabled}
                onClick={() => respond('submit', { value: comment })}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--ksadk-interaction-primary-background)] px-3 text-xs font-medium text-[var(--ksadk-interaction-primary-foreground)] shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-55"
              >
                提交
              </button>
            </div>
          </div>
        )}

        {active.status === 'resolving' ? (
          <p className="mt-2 text-xs text-[var(--ksadk-interaction-muted)]">正在提交，请稍候…</p>
        ) : null}
      </div>
    </div>
  );
}

export function InteractionOutcomeLabel({ outcome }: { outcome: string }) {
  return (
    <span
      className={cn(
        'rounded border px-1.5 py-0.5 text-xs font-medium',
        outcome === 'approved'
          ? 'border-emerald-300 text-emerald-700 dark:border-emerald-900 dark:text-emerald-300'
          : outcome === 'rejected'
            ? 'border-rose-300 text-rose-700 dark:border-rose-900 dark:text-rose-300'
            : 'border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-300',
      )}
    >
      {OUTCOME_LABEL[outcome] || outcome}
    </span>
  );
}
