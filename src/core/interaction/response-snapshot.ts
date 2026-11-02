import { jsonValue, type JsonValue } from '../../types/json-value.js';
import type { Interaction } from './types.js';

type Schema = Record<string, unknown>;
const record = (value: unknown): Schema | undefined => value !== null
  && typeof value === 'object' && !Array.isArray(value) ? value as Schema : undefined;

class DisplayBudgetExceeded extends Error {}
function budget(): () => void {
  let remaining = 8192;
  return () => { if (--remaining < 0) throw new DisplayBudgetExceeded(); };
}

function reference(ref: unknown, root: Schema, tick: () => void): unknown {
  if (ref === '#') return root;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) throw new DisplayBudgetExceeded();
  try {
    let node: unknown = root;
    for (const token of decodeURIComponent(ref.slice(2)).split('/')) {
      tick();
      const object = record(node) ?? (Array.isArray(node) ? node : undefined);
      const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!object || !Object.hasOwn(object, key)) throw new DisplayBudgetExceeded();
      node = (object as Record<string, unknown>)[key];
    }
    return node;
  } catch { throw new DisplayBudgetExceeded(); }
}

/** All same-value constraints contribute sensitive annotations, including alternatives. */
function expanded(schemas: unknown[], root: Schema, tick: () => void): Schema[] {
  const seen = new Set<Schema>();
  const pending = [...schemas];
  while (pending.length) {
    tick();
    const candidate = pending.pop();
    if (typeof candidate === 'boolean') continue;
    const schema = record(candidate);
    if (!schema) throw new DisplayBudgetExceeded();
    if (seen.has(schema)) continue;
    seen.add(schema);
    if ((schema !== root && Object.hasOwn(schema, '$id'))
      || Object.hasOwn(schema, '$dynamicRef') || Object.hasOwn(schema, '$recursiveRef')) {
      throw new DisplayBudgetExceeded();
    }
    if (Object.hasOwn(schema, '$ref')) pending.push(reference(schema.$ref, root, tick));
    for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
      const choices = schema[keyword];
      if (choices !== undefined && !Array.isArray(choices)) throw new DisplayBudgetExceeded();
      if (Array.isArray(choices)) pending.push(...choices);
    }
    for (const keyword of ['if', 'then', 'else']) {
      if (Object.hasOwn(schema, keyword)) pending.push(schema[keyword]);
    }
    for (const children of [record(schema.dependentSchemas), record(schema.dependencies)]) {
      for (const value of Object.values(children || {})) {
        if (record(value) || typeof value === 'boolean') pending.push(value);
      }
    }
  }
  return [...seen];
}

const sensitive = (schema: Schema): boolean => schema.writeOnly === true
  || schema.format === 'password' || schema['x-sensitive'] === true
  || schema['x-codex-is-secret'] === true;

/** Pass the original root when checking a property's schema containing local $ref. */
export function isSensitiveInputSchema(schema: Schema, root: Schema = schema): boolean {
  try { return expanded([schema], root, budget()).some(sensitive); } catch { return true; }
}

/** Make an immutable display-only answer; never use this value to resume an Agent. */
export function redactInputResponse(schema: Schema, value: JsonValue): JsonValue {
  const tick = budget();
  function visit(schemas: unknown[], input: JsonValue, depth: number): JsonValue {
    tick();
    if (depth > 48) throw new DisplayBudgetExceeded();
    const constraints = expanded(schemas, schema, tick);
    if (constraints.some(sensitive)) return null;
    if (Array.isArray(input)) return input.map((entry, index) => {
      const children: unknown[] = [];
      for (const parent of constraints) {
        const prefix = Array.isArray(parent.prefixItems) ? parent.prefixItems : undefined;
        const tuple = Array.isArray(parent.items) ? parent.items : undefined;
        children.push(prefix && index < prefix.length ? prefix[index]
          : tuple ? index < tuple.length ? tuple[index] : parent.additionalItems ?? {} : parent.items ?? {});
        for (const keyword of ['contains', 'unevaluatedItems']) {
          if (Object.hasOwn(parent, keyword)) children.push(parent[keyword]);
        }
      }
      return visit(children, entry, depth + 1);
    });
    if (input === null || typeof input !== 'object') return input;
    return Object.fromEntries(Object.entries(input).map(([key, entry]) => {
      const children: unknown[] = [];
      for (const parent of constraints) {
        const properties = record(parent.properties);
        let matched = Boolean(properties && Object.hasOwn(properties, key));
        if (matched) children.push(properties![key]);
        for (const [pattern, patternSchema] of Object.entries(record(parent.patternProperties) || {})) {
          if (!new RegExp(pattern).test(key)) continue;
          matched = true;
          children.push(patternSchema);
        }
        if (!matched && Object.hasOwn(parent, 'additionalProperties')) children.push(parent.additionalProperties);
        if (Object.hasOwn(parent, 'unevaluatedProperties')) children.push(parent.unevaluatedProperties);
      }
      return [key, visit(children, entry, depth + 1)];
    }));
  }
  try {
    jsonValue(value);
    return visit([schema], value, 0);
  } catch { return null; }
}

/** Absence is distinct from null and from a submit command's acceptance receipt. */
export function submittedResponse(interaction: Interaction): { value: JsonValue } | undefined {
  if (interaction.kind !== 'structured_input' || interaction.status !== 'resolved'
    || interaction.outcome !== 'submitted' || !interaction.requestSchema
    || !Object.hasOwn(interaction, 'response')) return undefined;
  try {
    return { value: redactInputResponse(interaction.requestSchema, jsonValue(interaction.response)) };
  } catch { return undefined; }
}
