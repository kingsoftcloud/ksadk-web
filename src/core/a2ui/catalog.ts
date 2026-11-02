import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { canonicalize } from 'json-canonicalize';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import document from './assets/basic-v0_9_1.json';
import common from './assets/common-types-v0_9.json';
import manifest from './assets/manifest.json';
import legacy from './assets/legacy-seven-components.json';
import { jsonValue } from '../../types/json-value.js';

export const a2uiCatalog = document as Record<string, unknown>;
export const a2uiManifest = manifest;
export const legacyA2uiCatalog = legacy;
export type A2UIClientEventMessage = {
  userAction?: {
    name: string;
    surfaceId: string;
    sourceComponentId: string;
    context: Record<string, unknown>;
    timestamp: string;
  };
};

/** Full published document, including component properties and functions. */
export function catalogDigest(catalog: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalize(jsonValue(catalog)))));
}

const validator = new Ajv2020({ strict: false, allErrors: true, logger: false });
addFormats(validator);
validator.addSchema(common);
validator.addSchema(document);
validator.addSchema(legacy);
for (const alias of Object.keys(manifest.schema_resolution_aliases)) {
  validator.addSchema({ ...document, $id: alias });
}
const components = new Map(Object.keys(document.components).map(name => [
  name, validator.getSchema(`${document.$id}#/components/${name}`)!,
]));
const legacyComponents = new Map(Object.keys(legacy.components).map(name => [
  name, validator.getSchema(`${legacy.$id}#/components/${name}`)!,
]));

export function validateCatalogComponents(raw: unknown, catalogId = document.catalogId): void {
  if (!Array.isArray(raw) || raw.length > 2048) throw new Error('A2UI 组件列表无效或过大。');
  const ids = new Set<string>();
  for (const component of raw) {
    const entry = component as Record<string, unknown> | null;
    const registry = catalogId === legacy.catalogId ? legacyComponents : components;
    const validate = entry && typeof entry.component === 'string'
      ? registry.get(entry.component) : null;
    if (!validate || !validate(entry)) throw new Error('A2UI 组件或属性不符合已注册的官方目录。');
    if (typeof entry?.id !== 'string' || ids.has(entry.id)) throw new Error('A2UI 组件身份无效或重复。');
    ids.add(entry.id);
  }
}
