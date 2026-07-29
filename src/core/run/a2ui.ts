import {
  A2UI_SCHEMA_CONTEXT_DESCRIPTION,
  basicCatalog,
  buildCatalogContextValue,
} from '@copilotkit/a2ui-renderer';

// The agent currently emits the official v0.9 basic catalog id.  Creating a
// second catalog that happens to contain the same components changes that id,
// which makes the renderer reject every createSurface operation.
export const ksadkA2uiCatalog = basicCatalog;

export const ksadkA2uiAgentContext = {
  description: A2UI_SCHEMA_CONTEXT_DESCRIPTION,
  value: buildCatalogContextValue(ksadkA2uiCatalog),
};

/**
 * CopilotKit's v0.9 React renderer always begins rendering at component id
 * `root`. Early local A2UI events used a surface-specific `*-root` id and
 * were persisted that way. Keep the repair deliberately narrow so a valid
 * A2UI tree is never rewritten.
 */
export function normalizeA2uiOperations(
  operations: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return operations.map((operation) => {
    const update = operation.updateComponents;
    if (!update || typeof update !== 'object' || Array.isArray(update)) return operation;

    const components = (update as Record<string, unknown>).components;
    if (!Array.isArray(components)) return operation;

    const componentRecords = components.filter(
      (component): component is Record<string, unknown> => Boolean(
        component && typeof component === 'object' && !Array.isArray(component),
      ),
    );
    if (componentRecords.some((component) => component.id === 'root')) return operation;

    const legacyRoots = componentRecords.filter(
      (component) => typeof component.id === 'string' && component.id.endsWith('-root'),
    );
    if (legacyRoots.length !== 1) return operation;

    const legacyRoot = legacyRoots[0];
    return {
      ...operation,
      updateComponents: {
        ...update,
        components: components.map((component) => component === legacyRoot
          ? { ...legacyRoot, id: 'root' }
          : component),
      },
    };
  });
}
