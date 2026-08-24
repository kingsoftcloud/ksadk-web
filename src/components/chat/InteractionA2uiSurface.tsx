import type { A2UIClientEventMessage } from '@copilotkit/a2ui-renderer';
import { A2UIActivityMessage } from './A2UIActivityMessage';
import type { A2uiPresentation } from '../../core/interaction/types.js';

/**
 * Renders a validated A2UI v0.9.1 interaction surface. Only reached when
 * `validateA2uiPresentation` accepted the wire version and catalog
 * digest; any unknown component fails inside the renderer and the user
 * still has the explicit submit/cancel controls below.
 */
export function InteractionA2uiSurface({
  a2ui,
  disabled,
  onSubmit,
  onCancel,
}: {
  a2ui: A2uiPresentation;
  disabled: boolean;
  onSubmit: (payload: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  return (
    <div className="mt-3" data-testid="interaction-a2ui-surface">
      <A2UIActivityMessage
        surfaceId={`interaction-${a2ui.wireVersion}`}
        messages={a2ui.messages}
        onAction={disabled ? undefined : (message: A2UIClientEventMessage) => {
          const context = (message.userAction?.context || {}) as Record<string, unknown>;
          const payload =
            typeof context.payload === 'object' && context.payload !== null
              ? (context.payload as Record<string, unknown>)
              : { ...context };
          onSubmit(payload);
        }}
      />
      {disabled ? null : (
        <button
          type="button"
          data-testid="interaction-a2ui-cancel"
          onClick={onCancel}
          className="mt-1 inline-flex min-h-8 items-center rounded-md px-3 py-1.5 text-xs font-medium text-slate-500 underline-offset-2 hover:underline dark:text-slate-400"
        >
          取消本次确认
        </button>
      )}
    </div>
  );
}
