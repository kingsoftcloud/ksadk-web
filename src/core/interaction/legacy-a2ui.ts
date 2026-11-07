import type { A2UIClientEventMessage } from '../a2ui/catalog.js';

export const LEGACY_SURFACE_KEY = 'x-ksadk-a2ui-surface-id';

export function isLegacyA2uiInput(schema: Record<string, unknown> | null) {
  return Boolean(schema?.[LEGACY_SURFACE_KEY])
    && Object.keys(schema || {}).every(key => key === LEGACY_SURFACE_KEY);
}

export function legacyA2uiAnswer(messages: Array<Record<string, unknown>>, action: A2UIClientEventMessage) {
  const context = action.userAction?.context || {};
  const payload = Object.hasOwn(context, 'payload') ? context.payload : context;
  let catalogId: string | undefined;
  let component: string | undefined;
  const sid = action.userAction?.surfaceId;
  for (const op of messages) {
    const create = op.createSurface as { surfaceId: string; catalogId: string } | undefined;
    const update = op.updateComponents as { surfaceId: string; components: Array<{ id: string; component: string }> } | undefined;
    const deleted = op.deleteSurface as { surfaceId: string } | undefined;
    if (create && create.surfaceId === sid) { catalogId = create.catalogId; component = undefined; }
    if (update && update.surfaceId === sid) {
      for (const entry of update.components) if (entry.id === action.userAction?.sourceComponentId) component = entry.component;
    }
    if (deleted && deleted.surfaceId === sid) { catalogId = undefined; component = undefined; }
  }
  // This is the built-in legacy Form's original answer envelope, not a
  // contract inferred from the Agent's business field names or interrupt type.
  return catalogId === 'a2ui.org/catalogs/basic/v1.0' && component === 'Form'
    ? { fields: payload, modified_data: payload, retry: true } : payload;
}
