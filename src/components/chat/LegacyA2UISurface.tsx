import { useState, type ReactNode } from 'react';
import type { A2UIClientEventMessage } from '../../core/a2ui/catalog.js';
import { legacyChoiceAnswer, type A2uiHistoryAnswer } from './a2ui-response-snapshot.js';

export const legacyCatalogId = 'a2ui.org/catalogs/basic/v1.0';
type RecordValue = Record<string, unknown>;
type Field = { name: string; label?: string; type?: string; required?: boolean; placeholder?: string; value?: unknown; options?: unknown[] };
const object = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown) => value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
const sameValue = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const inputClass = 'rounded border border-slate-300 px-3 py-2 dark:border-slate-600 dark:bg-slate-800';
const buttonClass = 'rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50';

/** The public Python SDK's original catalog, independent of business fields and tool names. */
export function LegacyA2UISurface({ surfaceId, messages, onAction, disabled, historyAnswer }: {
  surfaceId: string;
  messages: RecordValue[];
  onAction: (message: A2UIClientEventMessage) => void | Promise<void>;
  disabled: boolean;
  historyAnswer?: A2uiHistoryAnswer;
}) {
  const components = new Map<string, RecordValue>();
  let model: RecordValue = {};
  let generation = 0;
  for (const [index, operation] of messages.entries()) {
    if (object(operation.createSurface).surfaceId === surfaceId) generation = index;
    if (object(operation.deleteSurface).surfaceId === surfaceId) { components.clear(); model = {}; }
    const update = object(operation.updateComponents);
    if (update.surfaceId === surfaceId && Array.isArray(update.components)) {
      for (const raw of update.components) { const component = object(raw); components.set(String(component.id), component); }
    }
    const data = object(operation.updateDataModel);
    if (data.surfaceId === surfaceId) {
      if (!data.path || data.path === '/') model = structuredClone(object(data.value));
      else {
        const segments = String(data.path).split('/').slice(1).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
        if (segments.some(segment => ['__proto__', 'constructor', 'prototype'].includes(segment))) continue;
        let parent = model;
        for (const segment of segments.slice(0, -1)) {
          // Untrusted JSON paths must never alter object prototypes.
          parent[segment] = { ...object(parent[segment]) }; parent = object(parent[segment]);
        }
        const key = segments.at(-1);
        if (key && !['__proto__', 'constructor', 'prototype'].includes(key)) parent[key] = data.value;
      }
    }
  }
  const referenced = new Set([...components.values()].flatMap(c => Array.isArray(c.children) ? c.children.map(String) : []));
  const submit = async (componentId: string, name: string, context: RecordValue) => {
    if (disabled || historyAnswer) return;
    await onAction({ userAction: {
      surfaceId, sourceComponentId: componentId, name, context, timestamp: new Date().toISOString(),
    }});
  };
  const render = (id: string, ancestors: Set<string>): ReactNode => {
    const c = components.get(id);
    if (!c || ancestors.has(id) || ancestors.size > 64) return <div role="alert" key={id}>卡片组件引用无效。</div>;
    const path = new Set(ancestors).add(id);
    const children = Array.isArray(c.children) ? c.children.map(child => render(String(child), path)) : [];
    switch (c.component) {
      case 'Text': return <p key={id} className={c.variant === 'title' ? 'text-lg font-semibold' : c.variant === 'error' ? 'text-red-600' : ''}>{text(c.text)}</p>;
      case 'Card': return <section key={id} className="space-y-3 rounded border p-4"><h3 className="font-semibold">{text(c.title)}</h3><div className="whitespace-pre-wrap">{text(c.body)}</div>{children}<p className="text-sm text-slate-500">{text(c.footer)}</p></section>;
      case 'Form': return <LegacyForm key={JSON.stringify([surfaceId, generation, id])} component={c} model={model} disabled={disabled} historyAnswer={historyAnswer} submit={values => submit(id, 'submit', {payload: values})}>{children}</LegacyForm>;
      case 'ApprovalBar': return <section key={id} className="space-y-3"><p>{text(c.summary)}</p><div className="flex gap-3">
        <button className={buttonClass} type="button" disabled={disabled} onClick={() => void submit(id, 'approve', {confirmed: true, approved: true})}>{text(c.approve_label) || '批准'}</button>
        <button className={inputClass} type="button" disabled={disabled} onClick={() => void submit(id, 'deny', {confirmed: false, approved: false})}>{text(c.deny_label) || '拒绝'}</button>
      </div></section>;
      case 'Select': case 'RadioGroup': case 'CheckboxGroup': return <LegacyChoice key={JSON.stringify([surfaceId, generation, id])} component={c} disabled={disabled} historyAnswer={historyAnswer} submit={value => submit(id, 'change', {value})} />;
      default: return <div role="alert" key={id}>当前组件目录不支持组件：{text(c.component)}</div>;
    }
  };
  const roots = [...components.keys()].filter(id => !referenced.has(id));
  if (components.size && !roots.length) return <div role="alert">卡片组件存在循环引用。</div>;
  return <div className="space-y-4" data-testid="legacy-a2ui-surface">{roots.map(id => render(id, new Set()))}</div>;
}

function LegacyForm({component, model, disabled, submit, children, historyAnswer}: {
  component: RecordValue; model: RecordValue; disabled: boolean;
  submit: (values: RecordValue) => Promise<void>; children: ReactNode;
  historyAnswer?: A2uiHistoryAnswer;
}) {
  const rawFields = Array.isArray(component.fields) ? component.fields : [];
  const fields = rawFields.filter((field): field is Field => Boolean(field && typeof field === 'object' && typeof field.name === 'string'));
  const remoteValues: RecordValue = Object.fromEntries(fields.map(field => [field.name,
    field.value ?? model[field.name] ?? (['bool', 'boolean'].includes(field.type ?? '') ? false : ''),
  ]));
  const remoteKey = JSON.stringify(remoteValues);
  const [draft, setDraft] = useState(() => ({ remoteKey, remoteValues, values: remoteValues }));
  let values = draft.values;
  if (draft.remoteKey !== remoteKey) {
    // Apply changed server values without discarding drafts in other fields.
    values = Object.fromEntries(Object.entries(remoteValues).map(([name, value]) => [name,
      Object.hasOwn(draft.remoteValues, name) && sameValue(draft.remoteValues[name], value)
        ? draft.values[name] : value,
    ]));
    setDraft({ remoteKey, remoteValues, values });
  }
  const update = (name: string, value: unknown) => setDraft(previous => ({
    ...previous, values: { ...previous.values, [name]: value },
  }));
  if (fields.length !== rawFields.length) return <div role="alert">表单字段格式无效。</div>;
  return <form className="space-y-4" onSubmit={event => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity() || disabled) return;
    const result = {...values};
    for (const field of fields) {
      if (['int', 'integer', 'number', 'float'].includes(field.type ?? '') && result[field.name] !== '') result[field.name] = Number(result[field.name]);
      if (result[field.name] === '' && !field.required) delete result[field.name];
    }
    void submit(result);
  }}>
    <h3 className="font-semibold">{text(component.title)}</h3>
    <fieldset disabled={disabled} className="space-y-3">
      {fields.map(field => {
        const isBool = ['bool', 'boolean'].includes(field.type ?? '');
        const isNumber = ['int', 'integer', 'number', 'float'].includes(field.type ?? '');
        const history = historyAnswer?.at([field.name]);
        const value = history ? history.value : values[field.name];
        return <label className="flex flex-col gap-1" key={field.name}><span>{field.label || field.name}{field.required ? ' *' : ''}</span>
          {history && (history.hidden || !history.found || value === null) ? <span>{history.hidden ? '已隐藏' : history.found ? 'null' : '未提交'}</span> :
          <input className={inputClass} name={field.name} aria-label={field.label || field.name}
            type={isBool ? 'checkbox' : isNumber ? 'number' : 'text'}
            required={field.required && !isBool} placeholder={field.placeholder}
            step={['int', 'integer'].includes(field.type ?? '') ? '1' : isNumber ? 'any' : undefined}
            {...(isBool ? {checked: Boolean(value)} : {value: text(value)})}
            onChange={event => update(field.name, isBool ? event.target.checked : event.target.value)} />}
        </label>;
      })}
      {children}
      <button type="submit" className={buttonClass} disabled={disabled}>{text(component.submit_label) || '提交'}</button>
    </fieldset>
  </form>;
}

function LegacyChoice({component, disabled, submit, historyAnswer}: { component: RecordValue; disabled: boolean; submit: (value: unknown) => Promise<void>; historyAnswer?: A2uiHistoryAnswer }) {
  const multiple = component.component === 'CheckboxGroup';
  const options = (Array.isArray(component.options) ? component.options : []).map(raw => {
    const option = object(raw); return {value: option.value ?? raw, label: text(option.label ?? option.value ?? raw)};
  });
  const remoteValue: unknown = component.value ?? (multiple ? [] : '');
  const remoteKey = JSON.stringify([multiple, remoteValue]);
  const [draft, setDraft] = useState(() => ({ remoteKey, value: remoteValue }));
  let value = draft.value;
  if (draft.remoteKey !== remoteKey) {
    value = remoteValue;
    setDraft({ remoteKey, value });
  }
  const history = historyAnswer ? legacyChoiceAnswer(historyAnswer) : undefined;
  const selected = history ? history.value : value;
  return <label className="flex flex-col gap-1"><span>{text(component.label)}</span>{history && (history.hidden || !history.found || selected === null)
    ? <span>{history.hidden ? '已隐藏' : history.found ? 'null' : '未提交'}</span>
    : <select className={inputClass} disabled={disabled} multiple={multiple}
    value={multiple ? (Array.isArray(selected) ? selected.map(text) : []) : text(selected)}
    onChange={event => {
      const selected = multiple ? [...event.target.selectedOptions].map(option => options.find(o => text(o.value) === option.value)?.value) : options.find(o => text(o.value) === event.target.value)?.value;
      setDraft(previous => ({ ...previous, value: selected })); void submit(selected);
    }}><option value="" disabled>请选择</option>{options.map((option, i) => <option key={i} value={text(option.value)}>{option.label}</option>)}</select>}</label>;
}
