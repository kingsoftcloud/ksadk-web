import type { A2UIClientEventMessage } from '../a2ui/catalog.js';
import { legacyA2uiCatalog } from '../a2ui/catalog.js';
import { defaultA2uiCatalogRegistry, type A2uiCatalogRegistry } from '../a2ui/registry.js';
import type { A2uiPresentation } from './types.js';

export type A2uiApprovalAction = 'approve' | 'reject';
export type A2uiApprovalBinding = {
  surfaceId: string; componentId: string; eventName: string; action: A2uiApprovalAction;
};
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};

/** Only declared events on live, reachable components own an approval action. */
export function a2uiApprovalBindings(presentation: A2uiPresentation,
  registry: A2uiCatalogRegistry = defaultA2uiCatalogRegistry): A2uiApprovalBinding[] {
  const bindings: A2uiApprovalBinding[] = [];
  let model: ReturnType<A2uiCatalogRegistry['validateMessages']> | undefined;
  try {
    model = registry.validateMessages(presentation.messages);
    const ids = new Set<string>();
    for (const message of presentation.messages) {
      const create = record(message.createSurface), remove = record(message.deleteSurface);
      if (typeof create.surfaceId === 'string') ids.add(create.surfaceId);
      if (typeof remove.surfaceId === 'string') ids.delete(remove.surfaceId);
    }
    for (const surfaceId of ids) {
      const surface = model.getSurface(surfaceId);
      if (!surface) continue;
      const components = surface.componentsModel;
      const legacy = surface.defaultCatalog.id === legacyA2uiCatalog.catalogId;
      const children = (id: string): string[] => {
        if (!legacy) return components.getChildIds(id);
        const refs = record(components.get(id)?.componentTree).children;
        return Array.isArray(refs) ? refs.filter((ref): ref is string => typeof ref === 'string') : [];
      };
      const referenced = new Set([...components.keys].flatMap(children));
      const pending = legacy ? [...components.keys].filter(id => !referenced.has(id)) : [surface.rootId];
      const visited = new Set<string>();
      while (pending.length) {
        const componentId = pending.pop()!;
        if (visited.has(componentId)) continue;
        visited.add(componentId);
        const component = record(components.get(componentId)?.componentTree);
        pending.push(...children(componentId));
        const add = (eventName: string, action: A2uiApprovalAction) =>
          bindings.push({ surfaceId, componentId, eventName, action });
        if (legacy && component.component === 'ApprovalBar') {
          add('approve', 'approve');
          add('deny', 'reject');
        } else {
          const name = record(record(component.action).event).name;
          if (name === 'approve' || name === 'reject') add(name, name);
        }
      }
    }
    return bindings;
  } catch {
    return [];
  } finally { model?.dispose(); }
}

/** A component's context/label cannot override its saved decision semantics. */
export function a2uiApprovalResponse(bindings: readonly A2uiApprovalBinding[],
  message: A2UIClientEventMessage) {
  const event = message.userAction;
  const binding = event && bindings.find(item => item.surfaceId === event.surfaceId
    && item.componentId === event.sourceComponentId && item.eventName === event.name);
  return binding ? { action: binding.action, response: { decision: binding.action } } : null;
}
