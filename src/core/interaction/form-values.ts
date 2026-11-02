import { jsonValue, type JsonValue } from '../../types/json-value.js';
import { inputSchemaPredicate, validateInput } from './schema.js';

type Schema = Record<string, unknown>;
const object = (value: unknown): Schema | undefined => value !== null && typeof value === 'object'
  && !Array.isArray(value) ? value as Schema : undefined;
const own = (value: Schema, key: string): unknown => Object.hasOwn(value, key) ? value[key] : undefined;
const part = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1');
const numeric = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

/** Exact decimal representation of a JSON number, without binary rounding. */
function decimal(value: string): string {
  const [mantissa, exponent = '0'] = value.toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.replace(/^-/, '').split('.');
  const digits = (whole + fraction).replace(/^0+/, '').replace(/0+$/, '');
  if (!digits) return '0';
  const trailing = (whole + fraction).length - (whole + fraction).replace(/0+$/, '').length;
  return `${value.startsWith('-') ? '-' : ''}${digits}e${Number(exponent) - fraction.length + trailing}`;
}

function scalar(value: JsonValue, types: unknown[]): JsonValue {
  if (typeof value !== 'string') return value;
  if (types.includes('boolean') && (value === 'true' || value === 'false')) return value === 'true';
  if (!types.some(type => type === 'number' || type === 'integer')
    || value.length > 1024 || !numeric.test(value)) return value;
  const result = Number(value);
  if (!Number.isFinite(result) || decimal(value) !== decimal(JSON.stringify(result))) return value;
  if (!types.includes('number') && !Number.isSafeInteger(result)) return value;
  return result === 0 ? 0 : result;
}

/** Adapt only answers to the saved business Schema, never arbitrary Agent JSON. */
export function normalizeFormAnswer(schema: Schema, answer: unknown): JsonValue {
  const raw = jsonValue(answer);
  const predicate = inputSchemaPredicate(schema);
  let nodes = 0;
  const valid = (path: string, value: JsonValue): boolean => {
    try { return predicate(path, value); } catch { return false; }
  };
  const reference = (ref: unknown): { node: unknown; path: string } | undefined => {
    if (typeof ref !== 'string' || !ref.startsWith('#')) return;
    let path: string;
    try { path = decodeURIComponent(ref.slice(1)); } catch { return; }
    if (path !== '' && !path.startsWith('/')) return;
    let node: unknown = schema;
    for (const key of path === '' ? [] : path.slice(1).split('/')) {
      const decoded = key.replace(/~1/g, '/').replace(/~0/g, '~');
      node = Array.isArray(node) ? node[Number(decoded)] : object(node) ? own(node as Schema, decoded) : undefined;
    }
    return { node, path };
  };
  const visit = (rawNode: unknown, path: string, value: JsonValue, depth = 0): JsonValue => {
    const node = object(rawNode);
    if (++nodes > 8192 || depth > 48 || !node || valid(path, value)) return value;
    const original = value;
    const ref = reference(node.$ref);
    if (ref) value = visit(ref.node, ref.path, value, depth + 1);
    if (Array.isArray(node.allOf)) node.allOf.forEach((branch, i) => {
      value = visit(branch, `${path}/allOf/${i}`, value, depth + 1);
    });
    const union = Array.isArray(node.oneOf) ? 'oneOf' : 'anyOf';
    const alternatives = node[union];
    if (Array.isArray(alternatives)) {
      const candidates = alternatives.map((branch, i) => visit(branch, `${path}/${union}/${i}`, value, depth + 1))
        .filter(candidate => valid(path, candidate));
      const unique = new Map(candidates.map(candidate => [JSON.stringify(candidate), candidate]));
      return unique.size === 1 ? [...unique.values()][0] : original;
    }
    if (Array.isArray(value)) {
      const tuple = Array.isArray(node.items);
      const prefix = tuple ? node.items as unknown[] : Array.isArray(node.prefixItems) ? node.prefixItems : [];
      const tail = tuple ? node.additionalItems : node.items;
      return value.map((child, i) => visit(i < prefix.length ? prefix[i] : tail,
        i < prefix.length ? `${path}/${tuple ? 'items' : 'prefixItems'}/${i}`
          : `${path}/${tuple ? 'additionalItems' : 'items'}`, child, depth + 1));
    }
    const fields = object(value);
    if (fields) {
      const result: Record<string, JsonValue> = {};
      const properties = object(node.properties) || {};
      const patterns = object(node.patternProperties) || {};
      for (const [key, rawChild] of Object.entries(fields)) {
        let child = rawChild as JsonValue;
        let matched = false;
        if (Object.hasOwn(properties, key)) {
          child = visit(properties[key], `${path}/properties/${part(key)}`, child, depth + 1);
          matched = true;
        }
        for (const [pattern, sub] of Object.entries(patterns)) {
          if (new RegExp(pattern, 'u').test(key)) {
            child = visit(sub, `${path}/patternProperties/${part(pattern)}`, child, depth + 1);
            matched = true;
          }
        }
        if (!matched && object(node.additionalProperties)) {
          child = visit(node.additionalProperties, `${path}/additionalProperties`, child, depth + 1);
        }
        Object.defineProperty(result, key, { value: child, enumerable: true, configurable: true, writable: true });
      }
      return result;
    }
    return scalar(value, Array.isArray(node.type) ? node.type : [node.type]);
  };
  const result = visit(schema, '', raw);
  const validation = validateInput(schema, result);
  if (!validation.valid) throw new TypeError(validation.issues.join('；'));
  return result;
}
