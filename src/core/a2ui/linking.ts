/** Link application-provided offline assets for the public core compiler.
 * Original documents remain the validation authority and digest inputs.
 */
type Schema = Record<string, unknown>;
const maps = new Set(['components', 'functions', '$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas']);
const single = new Set(['theme', 'items', 'additionalProperties', 'additionalItems', 'contains', 'propertyNames',
  'not', 'if', 'then', 'else', 'unevaluatedProperties', 'unevaluatedItems', 'contentSchema']);
const arrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const common = 'https://a2ui.org/specification/v0_9/common_types.json';

export function linkA2uiCatalog(document: Schema, resolve: (address: string) => unknown): Schema {
  const root = String(document.$id || document.catalogId);
  const resolving = new Set<string>();
  const address = (base: string, ref: string) => ref.startsWith('#') ? base.split('#')[0] + ref
    : /^[a-z][a-z0-9+.-]*:/i.test(ref) ? ref : new URL(ref, base).href;
  const link = (schema: unknown, base: string, resource = false): unknown => {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return structuredClone(schema);
    const node = schema as Schema;
    const scope = typeof node.$id === 'string' && node.$id !== base ? address(base, node.$id) : base;
    const result = structuredClone(node);
    for (const key of ['$ref', '$dynamicRef']) {
      const ref = node[key];
      if (typeof ref !== 'string') continue;
      const target = address(scope, ref);
      const resolved = resolve(target);
      if (resolved === undefined) throw new Error('A2UI 目录包含未提供的离线 Schema 引用。');
      if (target.split('#')[0] === root) result[key] = '#' + (target.split('#')[1] || '');
      else if (target.split('#')[0] !== common) {
        if (resolving.has(target)) throw new Error('循环的外部 A2UI Schema 资产无法完成链接。');
        resolving.add(target);
        let replacement;
        try { replacement = link(resolved, target.split('#')[0], true); }
        finally { resolving.delete(target); }
        const siblings = Object.fromEntries(Object.entries(node).filter(([name]) => name !== key));
        return Object.keys(siblings).length ? { allOf: [replacement, link(siblings, scope, resource)] } : replacement;
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (maps.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, link(child, scope, resource)]));
      } else if (single.has(key) && (typeof value === 'object' || typeof value === 'boolean')) {
        result[key] = link(value, scope, resource);
      } else if (arrays.has(key) && Array.isArray(value)) result[key] = value.map(child => link(child, scope, resource));
    }
    if (resource) { delete result.$id; delete result.$schema; delete result.$anchor; }
    return result;
  };
  return link(document, root) as Schema;
}
