import { canonicalize } from 'json-canonicalize';
import type { A2uiCatalogRegistry } from './registry.js';

/** Compare actual surface content; a reused surface id alone is insufficient. */
export function a2uiSurfaceSnapshot(surfaceId: string, messages: Record<string, unknown>[],
  registry: A2uiCatalogRegistry): string | undefined {
  let model: ReturnType<A2uiCatalogRegistry['validateMessages']> | undefined;
  try {
    model = registry.validateMessages(messages.filter(message => Object.values(message).some(
      value => value && typeof value === 'object' && (value as { surfaceId?: string }).surfaceId === surfaceId,
    )));
    const surface = model.getSurface(surfaceId);
    if (!surface) return undefined;
    return canonicalize({ catalogId: surface.defaultCatalog.id, rootId: surface.rootId,
      theme: surface.theme, metadata: surface.metadata,
      components: [...surface.componentsModel.getAll().entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, component]) => component.componentTree),
      data: surface.dataModel.get('/'),
    });
  } catch { return undefined; } finally { model?.dispose(); }
}
