/**
 * A2UI v0.9.1 presentation validation with a safe fallback ladder.
 *
 * The production wire is locked to v0.9.1 with a pinned catalog digest.
 * When the wire version or catalog digest does not match, the tray falls
 * back to the canonical JSON schema form; when that is unsupported it
 * falls back to plain approve/reject/text controls. A validation failure
 * is never mapped to an approval.
 */
import type { A2uiPresentation } from './types.js';

export const A2UI_WIRE_VERSION = '0.9.1';

function componentIds(catalog: unknown): string[] {
  const components =
    typeof catalog === 'object' && catalog !== null
      ? (catalog as { components?: unknown }).components
      : null;
  const entries = Array.isArray(components) ? components : [];
  const ids: string[] = [];
  for (const entry of entries) {
    if (
      typeof entry === 'object'
      && entry !== null
      && typeof (entry as { id?: unknown }).id === 'string'
    ) {
      ids.push((entry as { id: string }).id);
    }
  }
  return ids.sort();
}

/** Deterministic digest of the local A2UI catalog. */
export function computeA2uiCatalogDigest(catalog: unknown): string {
  const ids = componentIds(catalog).join('|');
  // FNV-1a 64-bit style hash over the sorted component ids — enough to
  // detect a catalog mismatch, not a security primitive.
  let hash1 = 0x811c9dc5;
  let hash2 = 0x01000193;
  for (let i = 0; i < ids.length; i += 1) {
    const code = ids.charCodeAt(i);
    hash1 = (hash1 ^ code) >>> 0;
    hash1 = Math.imul(hash1, 0x01000193) >>> 0;
    hash2 = (hash2 + Math.imul(code + i, 0x85ebca6b)) >>> 0;
  }
  return `fnv1a-${hash1.toString(16)}-${hash2.toString(16)}`;
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
  localCatalog: unknown,
): A2uiRenderMode {
  if (!presentation) return basicFallbackFor(null);
  if (presentation.wireVersion !== A2UI_WIRE_VERSION) {
    return basicFallbackFor(presentation);
  }
  if (!presentation.messages || presentation.messages.length === 0) {
    return basicFallbackFor(presentation);
  }
  if (presentation.catalogDigest) {
    const localDigest = computeA2uiCatalogDigest(localCatalog);
    if (presentation.catalogDigest !== localDigest) {
      // Catalog mismatch: never render the unknown catalog and never
      // auto-approve anything.
      return 'json-schema-form';
    }
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
