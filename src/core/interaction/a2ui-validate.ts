/**
 * A2UI v0.9.1 presentation validation with a safe fallback ladder.
 *
 * Interaction presentations use v0.9.1 and the selected registered catalog's digest.
 * When the wire version or catalog digest does not match, the tray falls
 * back to the canonical JSON schema form; when that is unsupported it
 * falls back to plain approve/reject/text controls. A validation failure
 * is never mapped to an approval.
 */
import type { A2uiPresentation, Interaction } from './types.js';
import { a2uiManifest, legacyA2uiCatalog, catalogDigest } from '../a2ui/catalog.js';
import { A2uiCatalogRegistry, defaultA2uiCatalogRegistry } from '../a2ui/registry.js';

export const A2UI_WIRE_VERSION = '0.9.1';

/** Deterministic digest of the local A2UI catalog. */
export function computeA2uiCatalogDigest(catalog: unknown): string {
  return catalogDigest(catalog);
}

export type A2uiRenderMode =
  | 'a2ui'
  | 'json-schema-form'
  | 'basic-controls';

/**
 * Decide how an Interaction's presentation may render. Unknown components
 * or a catalog mismatch never yield 'a2ui'; the safest usable fallback
 * wins.
 */
export function validateA2uiPresentation(
  presentation: A2uiPresentation | null | undefined,
  localCatalog: unknown = defaultA2uiCatalogRegistry,
): A2uiRenderMode {
  if (!presentation) return basicFallbackFor(null);
  if (presentation.wireVersion !== A2UI_WIRE_VERSION) {
    return basicFallbackFor(presentation);
  }
  if (!presentation.messages || presentation.messages.length === 0) {
    return basicFallbackFor(presentation);
  }
  try {
    const registry = localCatalog instanceof A2uiCatalogRegistry ? localCatalog : defaultA2uiCatalogRegistry;
    const identities = new Set(presentation.messages.flatMap(message => {
      const create = message.createSurface as { catalogId?: string } | undefined;
      return create?.catalogId ? [create.catalogId] : [];
    }));
    if (identities.size !== 1) return 'json-schema-form';
    const entry = registry.get([...identities][0]);
    if (!entry) return 'json-schema-form';
    const localDigest = localCatalog instanceof A2uiCatalogRegistry ? entry.digest
      : computeA2uiCatalogDigest(localCatalog);
    // Old SDKs used the official digest on their legacy seven-component
    // presentation. This exception never applies to a custom catalog.
    const legacyDigest = [...identities][0] === legacyA2uiCatalog.catalogId
      && presentation.catalogDigest === a2uiManifest.catalog_digest;
    if (!presentation.catalogDigest || presentation.catalogDigest !== localDigest && !legacyDigest) {
      // Catalog mismatch: never render the unknown catalog and never
      // auto-approve anything.
      return 'json-schema-form';
    }
    const model = registry.validateMessages(presentation.messages);
    model.dispose();
  } catch {
    return 'json-schema-form';
  }
  return 'a2ui';
}

function basicFallbackFor(
  presentation: A2uiPresentation | null | undefined,
): A2uiRenderMode {
  return presentation && hasUsableSchema(presentation) ? 'json-schema-form' : 'basic-controls';
}

function hasUsableSchema(presentation: A2uiPresentation): boolean {
  return presentation.messages.some((message) => {
    const schema =
      (message as { inputSchema?: unknown }).inputSchema
      ?? (message as { input_schema?: unknown }).input_schema
      ?? (message as { schema?: unknown }).schema;
    return typeof schema === 'object' && schema !== null;
  });
}


/** Approval details use the application's registered catalog, live or restored. */
export function validatedApprovalA2ui(interaction: Pick<Interaction, 'kind' | 'presentation'>,
  registry: A2uiCatalogRegistry = defaultA2uiCatalogRegistry): A2uiPresentation | null {
  const a2ui = interaction.kind === 'approval' ? interaction.presentation?.a2ui : null;
  return a2ui && validateA2uiPresentation(a2ui, registry) === 'a2ui' ? a2ui : null;
}
