import { useState } from 'react';
import { Check, ChevronLeft, ChevronRight, XCircle } from 'lucide-react';
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

type InteractionTrayProps = {
  /** Pending (and in-flight) interactions for the current session. */
  interactions: readonly Interaction[];
  activeIndex: number;
  onSelectIndex: (index: number) => void;
  onRespond: (input: InteractionTrayRespondInput) => void;
  /** Local pinned A2UI catalog used for digest validation. */
  localCatalog?: unknown;
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
      retryable: Boolean(error.retryable),
    };
  }
  return null;
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
}: InteractionTrayProps) {
  const [comment, setComment] = useState('');
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});

  const active = interactions[Math.min(activeIndex, Math.max(interactions.length - 1, 0))];
  if (!active) return null;

  const expired = isExpired(active);
  const submitError = readSubmitError(active);
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
    presentationMode === 'a2ui'
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
    onRespond({
      interactionId: active.interactionId,
      expectedRevision: active.revision,
      action,
      response,
      idempotencyKey: interactionIdempotencyKey(active.interactionId, active.revision),
    });
  };

  return (
    <div
      data-testid="interaction-tray"
      data-interaction-status={active.status}
      data-interaction-count={interactions.length}
      className="mx-auto mb-2 w-full max-w-3xl px-6"
    >
      <div className="rounded-xl border border-amber-300/80 bg-amber-50/80 p-3 shadow-sm dark:border-amber-900/60 dark:bg-amber-950/30">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium text-amber-900 dark:text-amber-200">
            <span data-testid="interaction-tray-title">{active.title}</span>
            {interactions.length > 1 ? (
              <span
                data-testid="interaction-tray-count"
                className="rounded-full border border-amber-400/60 px-1.5 py-0.5 text-xs"
              >
                {activeIndex + 1}/{interactions.length}
              </span>
            ) : null}
          </div>
          {interactions.length > 1 ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                data-testid="interaction-tray-prev"
                disabled={activeIndex <= 0}
                onClick={() => onSelectIndex(Math.max(activeIndex - 1, 0))}
                className="rounded border border-amber-400/60 p-1 text-amber-900 disabled:opacity-40 dark:text-amber-200"
                aria-label="上一条待确认"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                data-testid="interaction-tray-next"
                disabled={activeIndex >= interactions.length - 1}
                onClick={() => onSelectIndex(Math.min(activeIndex + 1, interactions.length - 1))}
                className="rounded border border-amber-400/60 p-1 text-amber-900 disabled:opacity-40 dark:text-amber-200"
                aria-label="下一条待确认"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}
        </div>

        <p className="mt-2 text-sm text-slate-700 dark:text-slate-200" data-testid="interaction-tray-message">
          {active.message}
        </p>

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
        ) : (
          <div className="mt-3" data-testid="interaction-tray-basic">
            <input
              type="text"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="备注（可选）"
              disabled={disabled}
              data-testid="interaction-tray-comment"
              className="mb-2 w-full rounded-md border border-amber-300/70 bg-white px-2 py-1.5 text-sm dark:border-amber-900/60 dark:bg-slate-950"
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                data-testid="interaction-approve"
                disabled={disabled}
                onClick={() => respond('approve', { decision: 'approve', ...(comment ? { comment } : {}) })}
                className="inline-flex min-h-8 items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-55"
              >
                <Check className="h-3.5 w-3.5" />
                批准并继续
              </button>
              <button
                type="button"
                data-testid="interaction-reject"
                disabled={disabled}
                onClick={() => respond('reject', { decision: 'reject', ...(comment ? { comment } : {}) })}
                className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-55 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300 dark:hover:border-rose-800 dark:hover:bg-rose-950/30 dark:hover:text-rose-300"
              >
                <XCircle className="h-3.5 w-3.5" />
                拒绝
              </button>
              <button
                type="button"
                data-testid="interaction-cancel"
                disabled={disabled}
                onClick={() => respond('cancel', {})}
                className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-slate-500 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-55 dark:text-slate-400"
              >
                取消本次确认
              </button>
            </div>
          </div>
        )}

        {active.status === 'resolving' ? (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">正在提交，请稍候…</p>
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
