import type { A2UIClientEventMessage } from '../../core/a2ui/catalog.js';
import { A2UIActivityMessage } from './A2UIActivityMessage';
import type { A2uiPresentation } from '../../core/interaction/types.js';
import { jsonValue, type JsonValue } from '../../types/json-value.js';

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
  onSubmit: (payload: JsonValue) => void;
  onCancel: () => void;
}) {
  const surfaces = new Set<string>();
  for (const message of a2ui.messages) {
    const create = message.createSurface as { surfaceId?: string } | undefined;
    const remove = message.deleteSurface as { surfaceId?: string } | undefined;
    if (create?.surfaceId) surfaces.add(create.surfaceId);
    if (remove?.surfaceId) surfaces.delete(remove.surfaceId);
  }
  if (!surfaces.size) return <div role="alert">卡片没有可展示的 surface。</div>;
  return (
    <div className="mt-3" data-testid="interaction-a2ui-surface">
      {[...surfaces].map(surfaceId => <A2UIActivityMessage
        key={surfaceId}
        surfaceId={surfaceId}
        messages={a2ui.messages}
        disabled={disabled}
        onAction={disabled ? undefined : (message: A2UIClientEventMessage) => {
          const context = (message.userAction?.context || {}) as Record<string, unknown>;
          if (message.userAction?.name === 'cancel') { onCancel(); return; }
          const payload = Object.prototype.hasOwnProperty.call(context, 'payload')
            ? context.payload : context;
          onSubmit(jsonValue(payload));
        }}
      />)}
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
