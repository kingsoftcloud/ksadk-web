import type { ConversationItem, ConversationItemKind } from './types.js';

/**
 * A renderer declaration compiled into the trusted frontend bundle.
 *
 * This is deliberately an immutable catalog, not a runtime plugin API. A
 * Provider may produce a schema only after the host frontend ships its
 * matching renderer; Runtime payloads never supply executable renderer code.
 */
export type TrustedConversationRenderer = {
  id: string;
  schemaRef: string;
  kinds: readonly ConversationItemKind[];
};

export type TrustedRendererCatalog = {
  resolve(item: ConversationItem): TrustedConversationRenderer | undefined;
  entries(): readonly TrustedConversationRenderer[];
};

function nonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new Error(`trusted conversation renderer ${field} must not be empty`);
}

/** Build and freeze the host's exact kind/schema dispatch table once. */
export function createTrustedRendererCatalog(
  renderers: readonly TrustedConversationRenderer[],
): TrustedRendererCatalog {
  const bySchema = new Map<string, TrustedConversationRenderer>();
  for (const renderer of renderers) {
    nonEmpty(renderer.id, 'id');
    nonEmpty(renderer.schemaRef, 'schemaRef');
    if (!renderer.kinds.length) {
      throw new Error('trusted conversation renderer kinds must not be empty');
    }
    if (bySchema.has(renderer.schemaRef)) {
      throw new Error(`duplicate trusted conversation renderer schemaRef: ${renderer.schemaRef}`);
    }
    bySchema.set(renderer.schemaRef, Object.freeze({
      ...renderer,
      kinds: Object.freeze([...renderer.kinds]),
    }));
  }
  const entries = Object.freeze([...bySchema.values()]);
  return Object.freeze({
    resolve(item) {
      const renderer = bySchema.get(item.payloadSchemaRef);
      return renderer?.kinds.includes(item.kind) ? renderer : undefined;
    },
    entries() {
      return entries;
    },
  });
}
