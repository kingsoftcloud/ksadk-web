import { useCallback, useState } from 'react';
import { jsonValue, type JsonValue } from '../../types/json-value.js';
import { validateInput } from '../../core/interaction/schema.js';
import { useImeComposition } from '../../hooks/useImeComposition.js';
import { schemaFields } from './schema-fields.js';
import { isSensitiveInputSchema, redactInputResponse } from '../../core/interaction/response-snapshot.js';

type Schema = Record<string, unknown>;
type FieldProps = {
  schema: Schema; value: JsonValue | undefined; path: string; label: string;
  disabled: boolean; depth: number; onChange: (value: JsonValue | undefined) => void;
  onInvalid: (path: string, invalid: boolean) => void;
  readOnlySnapshot?: boolean; rootSchema?: Schema;
};
const controlClass = 'w-full rounded-md border border-[var(--ksadk-interaction-border)] bg-[var(--ksadk-interaction-control-background)] px-2 py-1.5 text-sm text-foreground';
const isObject = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const pretty = (value: JsonValue | undefined) => value === undefined ? '' : JSON.stringify(value, null, 2);

function Choices({ choices, multiple, allowOther, ...props }: FieldProps & {
  choices: unknown[]; multiple: boolean; allowOther: boolean;
}) {
  const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const selected = multiple && Array.isArray(props.value) ? props.value : [];
  const known = (value: unknown) => choices.some(choice => equal(choice, value));
  return <div data-testid={`interaction-field-${props.path || 'value'}`} className="space-y-1">
    {choices.map((choice, index) => <label key={index} className="flex min-h-10 items-center gap-2">
      <span>{index + 1}</span>
      <input type={multiple ? 'checkbox' : 'radio'} name={props.path}
        disabled={props.disabled} checked={multiple ? selected.some(value => equal(value, choice)) : equal(props.value, choice)}
        onChange={event => props.onChange(multiple
          ? event.target.checked ? [...selected, jsonValue(choice)] : selected.filter(value => !equal(value, choice))
          : jsonValue(choice))} />
      <span>{typeof choice === 'string' ? choice : JSON.stringify(choice)}</span>
    </label>)}
    {allowOther ? <input className={controlClass} disabled={props.disabled}
      aria-label={`${typeof props.schema.title === 'string' ? props.schema.title : props.label}：自定义回答`}
      type={isSensitiveInputSchema(props.schema, props.rootSchema) ? 'password' : 'text'}
      value={multiple ? selected.filter(value => !known(value)).join('\n') : known(props.value) ? '' : String(props.value ?? '')}
      onChange={event => props.onChange(multiple
        ? [...selected.filter(known), ...(event.target.value.trim() ? [event.target.value] : [])]
        : event.target.value)} /> : null}
  </div>;
}

function initialValue(schema: Schema): JsonValue | undefined {
  if (Object.hasOwn(schema, 'default')) return structuredClone(jsonValue(schema.default));
  if (Object.hasOwn(schema, 'const')) return structuredClone(jsonValue(schema.const));
  if (schema.type === 'null') return null;
  if (schema.type === 'object' || isObject(schema.properties)) {
    const result: Record<string, JsonValue> = {};
    for (const [name, child] of Object.entries(isObject(schema.properties) ? schema.properties : {})) {
      if (!isObject(child)) continue;
      const value = initialValue(child);
      if (value !== undefined && (Object.hasOwn(child, 'default') || Object.hasOwn(child, 'const'))) {
        Object.defineProperty(result, name, { value, enumerable: true, configurable: true, writable: true });
      }
    }
    return result;
  }
  return undefined;
}

function JsonEditor({ value, onChange, path, onInvalid, disabled, label }: FieldProps) {
  const [draft, setDraft] = useState(() => ({ external: value, text: pretty(value), invalid: false }));
  if (draft.external !== value) setDraft({ external: value, text: pretty(value), invalid: false });
  return <>
    <textarea aria-label={label} data-testid={`interaction-field-${path || 'value'}`}
      className={controlClass} disabled={disabled} value={draft.text} rows={5}
      spellCheck={false} aria-invalid={draft.invalid}
      onChange={event => {
        const text = event.target.value;
        try {
          const parsed = text.trim() ? jsonValue(JSON.parse(text)) : undefined;
          setDraft({ external: parsed, text, invalid: false });
          onInvalid(path, false); onChange(parsed);
        } catch {
          setDraft({ external: value, text, invalid: true });
          onInvalid(path, true);
        }
      }} />
    {draft.invalid ? <p role="alert">请输入合法 JSON；当前草稿尚未提交。</p> : null}
  </>;
}

function SchemaField(props: FieldProps) {
  const { value, onChange, path, disabled, label, onInvalid, depth } = props;
  const original = props.schema;
  if (props.readOnlySnapshot && isSensitiveInputSchema(original, props.rootSchema)) {
    return <div className="space-y-1 text-xs"><label className="block font-medium">{label}</label>
      <span data-testid={`interaction-field-${path || 'value'}`}>已隐藏</span></div>;
  }
  if (props.readOnlySnapshot && value === undefined) {
    return <div className="space-y-1 text-xs"><label className="block font-medium">{label}</label>
      <span data-testid={`interaction-field-${path || 'value'}`}>未提供</span></div>;
  }
  const alternatives = original.anyOf ?? original.oneOf;
  let schema = original;
  let nullable = Array.isArray(original.type) && original.type.includes('null');
  if (Array.isArray(alternatives) && alternatives.length === 2) {
    const nonNull = alternatives.filter(entry => isObject(entry) && entry.type !== 'null');
    if (nonNull.length === 1 && alternatives.some(entry => isObject(entry) && entry.type === 'null')) {
      schema = { ...original, anyOf: undefined, oneOf: undefined, ...nonNull[0] };
      nullable = true;
    }
  }
  const type = Array.isArray(schema.type) ? schema.type.filter(entry => entry !== 'null')[0] : schema.type;
  const set = (next: JsonValue | undefined) => { onInvalid(path, false); onChange(next); };
  const testId = `interaction-field-${path || 'value'}`;
  const field = schemaFields({ properties: { value: schema } })[0];
  const enumValues = field.enumValues;
  const complex = schema.$ref || schema.allOf || schema.anyOf || schema.oneOf
    || depth > 8 || (Array.isArray(schema.type) && schema.type.filter(entry => entry !== 'null').length > 1);
  let control;
  if (value === null && nullable) {
    control = <span data-testid={testId}>null <button type="button" disabled={disabled}
      onClick={() => set(undefined)}>填写值</button></span>;
  } else if (complex) {
    control = <JsonEditor {...props} />;
  } else if (Object.hasOwn(schema, 'const')) {
    control = <output data-testid={testId}>{pretty(jsonValue(schema.const))}</output>;
  } else if (enumValues) {
    control = <Choices {...props} choices={enumValues} multiple={type === 'array' && !Array.isArray(schema.enum)}
      allowOther={field.allowOther === true} onChange={set} />;
  } else if (type === 'object' || isObject(schema.properties)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    // Boolean property schemas are valid JSON Schema. Preserve the whole
    // object in the JSON fallback instead of silently dropping those fields.
    const hasBooleanSchema = Object.values(properties).some(child => typeof child === 'boolean');
    control = Object.keys(properties).length && !hasBooleanSchema ? <fieldset disabled={disabled} className="space-y-2 pl-2">
      {Object.entries(properties).map(([name, child]) => isObject(child) ? <SchemaField key={name}
        schema={child} value={isObject(value) ? value[name] : undefined}
        path={path ? `${path}/${name.replaceAll('~', '~0').replaceAll('/', '~1')}` : name.replaceAll('~', '~0').replaceAll('/', '~1')} label={`${typeof child.title === 'string' ? child.title : name}${required.includes(name) ? ' *' : ''}`}
        disabled={disabled} depth={depth + 1} onInvalid={onInvalid}
        readOnlySnapshot={props.readOnlySnapshot} rootSchema={props.rootSchema}
        onChange={next => {
          const entries = Object.entries(isObject(value) ? value : {}).filter(([key]) => key !== name);
          if (next !== undefined) entries.push([name, next]);
          onChange(Object.fromEntries(entries));
        }} /> : null)}
    </fieldset> : <JsonEditor {...props} />;
  } else if (type === 'boolean') {
    control = <select aria-label={label} data-testid={testId} className={controlClass} disabled={disabled}
      value={value === undefined ? '' : String(value)} onChange={event => set(event.target.value === '' ? undefined : event.target.value === 'true')}>
      <option value="">请选择</option><option value="true">是</option><option value="false">否</option>
    </select>;
  } else if (type === 'number' || type === 'integer') {
    control = <input aria-label={label} data-testid={testId} className={controlClass} type="number"
      disabled={disabled} step={type === 'integer' ? 1 : 'any'} value={typeof value === 'number' ? value : ''}
      onChange={event => set(event.target.value === '' ? undefined : event.target.valueAsNumber)} />;
  } else if (type === 'string') {
    control = <input aria-label={label} data-testid={testId} className={controlClass}
      type={isSensitiveInputSchema(schema, props.rootSchema) ? 'password' : 'text'}
      disabled={disabled} value={typeof value === 'string' ? value : ''} onChange={event => set(event.target.value)} />;
  } else {
    control = <JsonEditor {...props} />;
  }
  return <div className="space-y-1 text-xs">
    <label className="block font-medium">{label}</label>
    {typeof original.description === 'string' ? <p>{original.description}</p> : null}
    {control}
    {nullable && value !== null ? <button type="button" disabled={disabled} onClick={() => set(null)}>设为 null</button> : null}
  </div>;
}

/** A consumed answer is display-only; mounting it cannot validate or submit again. */
export function JsonSchemaInputSnapshot({ schema, value }: { schema: Schema; value: JsonValue }) {
  return <fieldset disabled inert className="mt-2 space-y-2" data-testid="interaction-input-snapshot">
    <SchemaField schema={schema} rootSchema={schema} value={redactInputResponse(schema, value)}
      path="" label={typeof schema.title === 'string' ? schema.title : '已提交内容'}
      disabled readOnlySnapshot depth={0} onChange={() => {}} onInvalid={() => {}} />
  </fieldset>;
}

/** All JSON answers, including scalars and complex schemas, use one submit path. */
export function JsonSchemaInputForm({ schema, disabled, onSubmit, onCancel }: {
  schema: Schema; disabled: boolean; onSubmit: (value: JsonValue) => void; onCancel: () => void;
}) {
  const [value, setValue] = useState(() => initialValue(schema));
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const composing = useImeComposition();
  const onInvalid = useCallback((path: string, failed: boolean) => setInvalid(previous => failed
    ? { ...previous, [path]: true }
    : Object.fromEntries(Object.entries(previous).filter(([key]) => path && key !== path && !key.startsWith(`${path}/`)))), []);
  return <form className="mt-3 space-y-2" data-testid="interaction-schema-form"
    onKeyDown={event => { if (event.key === 'Enter' && composing(event)) event.preventDefault(); }}
    onSubmit={event => {
      event.preventDefault();
      if (disabled) return;
      if (Object.values(invalid).some(Boolean)) { setError('请先修正 JSON 草稿。'); return; }
      const result = validateInput(schema, value);
      if (!result.valid) { setError(result.issues.join('；')); return; }
      setError(''); onSubmit(jsonValue(value));
    }}>
    <SchemaField schema={schema} rootSchema={schema} value={value} path="" label={typeof schema.title === 'string' ? schema.title : '请填写信息'}
      disabled={disabled} depth={0} onChange={setValue} onInvalid={onInvalid} />
    {error ? <p role="alert" className="text-xs text-rose-600">{error}</p> : null}
    <div className="flex gap-2">
      <button className="rounded-md bg-[var(--ksadk-interaction-primary-background)] px-3 py-1.5 text-xs text-[var(--ksadk-interaction-primary-foreground)] disabled:opacity-50"
        type="submit" disabled={disabled} data-testid="interaction-submit">提交</button>
      <button type="button" disabled={disabled} data-testid="interaction-form-cancel" onClick={onCancel}>取消</button>
    </div>
  </form>;
}
