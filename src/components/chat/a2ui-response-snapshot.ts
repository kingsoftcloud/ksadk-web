import { redactInputResponse } from '../../core/interaction/response-snapshot.js';
import type { JsonValue } from '../../types/json-value.js';

type Operation = Record<string, unknown>;
type Schema = Record<string, unknown>;
type Path = string[];
const object = (value: unknown): Schema | undefined => value !== null && typeof value === 'object'
  && !Array.isArray(value) ? value as Schema : undefined;
const own = (value: unknown, key: string): boolean => value !== null && typeof value === 'object' && Object.hasOwn(value, key);
const lookup = (value: JsonValue, path: Path): { found: boolean; value?: JsonValue } => {
  let current = value;
  for (const key of path) {
    if (!own(current, key)) return { found: false };
    current = (current as Record<string, JsonValue>)[key];
  }
  return { found: true, value: current };
};
const probeShape = (value: JsonValue): JsonValue => Array.isArray(value) ? value.map(probeShape)
  : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, probeShape(entry)])) : 'input-value';

export type A2uiHistoryAnswer = {
  value: JsonValue;
  summary: JsonValue;
  at: (path: Path) => { found: boolean; hidden: boolean; value?: JsonValue };
};

/** Schema-only annotations decide visibility; a real nullable answer remains null. */
export function a2uiHistoryAnswer(schema: Schema, accepted: JsonValue): A2uiHistoryAnswer {
  const value = redactInputResponse(schema, accepted);
  // Probe the same JSON shape once, so refs/patterns/array schemas use exactly
  // the shared redactor's semantics without duplicating a Schema resolver.
  const probe = redactInputResponse(schema, probeShape(value));
  const hiddenAt = (path: Path): boolean => {
    let current = probe;
    for (const key of path) {
      if (current === null) return true;
      if (!own(current, key)) return false;
      current = (current as Record<string, JsonValue>)[key];
    }
    return current === null;
  };
  const summarize = (entry: JsonValue, path: Path): JsonValue => {
    if (hiddenAt(path)) return '已隐藏';
    if (Array.isArray(entry)) return entry.map((child, index) => summarize(child, [...path, String(index)]));
    if (entry !== null && typeof entry === 'object') return Object.fromEntries(
      Object.entries(entry).map(([key, child]) => [key, summarize(child, [...path, key])]),
    );
    return entry;
  };
  return { value, summary: summarize(value, []), at: path => ({ ...lookup(value, path), hidden: hiddenAt(path) }) };
}

const pointer = (value: unknown): Path | undefined => {
  const path = object(value)?.path;
  if (typeof path !== 'string' || (path !== '' && !path.startsWith('/')) || /~(?![01])/u.test(path)) return undefined;
  const segments = path === '' || path === '/' ? [] : path.slice(1).split('/').map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'));
  return segments.some(token => ['__proto__', 'constructor', 'prototype'].includes(token)) ? undefined : segments;
};
const contains = (parent: Path, child: Path) => parent.length <= child.length && parent.every((key, index) => child[index] === key);
const encode = (path: Path) => path.length ? `/${path.map(key => key.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}` : '/';
const inputComponents = new Set(['TextField', 'CheckBox', 'ChoicePicker', 'Slider', 'DateTimeInput']);
const legacyChoices = new Set(['Select', 'RadioGroup', 'CheckboxGroup']);

function componentsFor(surfaceId: string, messages: Operation[]): Operation[] {
  const components = new Map<string, Operation>();
  for (const message of messages) {
    if (object(message.deleteSurface)?.surfaceId === surfaceId) components.clear();
    const update = object(message.updateComponents);
    if (update?.surfaceId !== surfaceId || !Array.isArray(update.components)) continue;
    for (const raw of update.components) {
      const component = object(raw);
      if (component && typeof component.id === 'string') components.set(component.id, component);
    }
  }
  return [...components.values()];
}

/** The legacy Choice action explicitly emits {value}; Form emits its field names. */
export function legacyChoiceAnswer(answer: A2uiHistoryAnswer): ReturnType<A2uiHistoryAnswer['at']> {
  return object(answer.value) ? answer.at(['value']) : answer.at([]);
}

export function projectA2uiHistoryResponse(
  surfaceId: string, messages: Operation[], schema: Schema, accepted: JsonValue,
  additionalInputs: readonly string[] = [],
): { messages: Operation[]; answer: A2uiHistoryAnswer; mapped: boolean; legacy: boolean } {
  const answer = a2uiHistoryAnswer(schema, accepted);
  const components = componentsFor(surfaceId, messages);
  const forms = components.filter(component => component.component === 'Form');
  const choices = components.filter(component => legacyChoices.has(String(component.component)));
  if (forms.length || choices.length) {
    // Several independent legacy actions have no submitted component identity.
    // Preserve the answer summary rather than assigning one answer to all forms.
    const fields = Array.isArray(forms[0]?.fields) ? forms[0].fields.map(field => object(field)?.name) : [];
    const value = object(answer.value);
    const mapped = forms.length === 1 && choices.length === 0 && Boolean(value)
      && Object.keys(value!).every(key => fields.includes(key))
      || forms.length === 0 && choices.length === 1 && legacyChoiceAnswer(answer).found
        && (!value || Object.keys(value).every(key => key === 'value'));
    return { messages, answer, mapped, legacy: true };
  }
  type Mapping = { model: Path; response: Path };
  const groups = new Map<string, Mapping[]>();
  let nodes = 0;
  let exceeded = false;
  const addContext = (raw: unknown, path: Path, mappings: Mapping[], depth = 0): void => {
    if (++nodes > 8192 || depth > 48) { exceeded = true; return; }
    const model = pointer(raw);
    if (model) { mappings.push({ model, response: path }); return; }
    const fields = object(raw);
    if (!fields || 'path' in fields || 'call' in fields) return;
    for (const [key, field] of Object.entries(fields)) {
      addContext(field, [...path, key], mappings, depth + 1);
      if (exceeded) break;
    }
  };
  for (const component of components) {
    if (component.component !== 'Button') continue;
    const event = object(object(component.action)?.event);
    const context = object(event?.context);
    if (!context || event?.name === 'cancel') continue;
    const mappings: Mapping[] = [];
    if (Object.hasOwn(context, 'payload')) addContext(context.payload, [], mappings);
    else addContext(context, [], mappings);
    const key = mappings.map(mapping => JSON.stringify([mapping.model, mapping.response])).sort().join('|');
    groups.set(key, mappings);
  }
  if (exceeded || groups.size !== 1) return { messages, answer, mapped: false, legacy: false };
  const mappings = [...groups.values()][0];
  // Conflicting action mappings do not identify which accepted action ran.
  for (const mapping of mappings) {
    if (mappings.some(other => encode(other.model) === encode(mapping.model)
      && encode(other.response) !== encode(mapping.response))) {
      return { messages, answer, mapped: false, legacy: false };
    }
  }
  const updates: Operation[] = [];
  const inputs = components.filter(component => inputComponents.has(String(component.component))
    || additionalInputs.includes(String(component.component)));
  if (!inputs.length) return { messages, answer, mapped: false, legacy: false };
  for (const component of inputs) {
    const path = pointer(component.value);
    const candidates = path ? mappings.filter(mapping => contains(mapping.model, path)) : [];
    const mapping = candidates.sort((left, right) => right.model.length - left.model.length)[0];
    if (!path || !mapping) return { messages, answer, mapped: false, legacy: false };
    const field = answer.at([...mapping.response, ...path.slice(mapping.model.length)]);
    if (field.hidden || !field.found || field.value === null) {
      updates.push({ id: component.id, component: 'Text', text: `${typeof component.label === 'string'
        ? `${component.label}：` : ''}${field.hidden ? '已隐藏' : field.found ? 'null' : '未提交'}` });
    }
  }
  const overlay: Operation[] = [];
  for (const mapping of mappings) {
    const field = answer.at(mapping.response);
    if (field.found) overlay.push({ version: 'v0.9.1', updateDataModel: {
      surfaceId, path: encode(mapping.model), value: field.value,
    } });
  }
  if (updates.length) overlay.push({ version: 'v0.9.1', updateComponents: { surfaceId, components: updates } });
  // The official DataModel owns and mutates objects passed to set('/'). A
  // historical overlay must never share those objects with persisted messages.
  return { messages: structuredClone([...messages, ...overlay]), answer, mapped: true, legacy: false };
}
