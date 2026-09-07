import { useState } from 'react';
import type { InteractionRequestSchemaField } from './schema-fields.js';
import { schemaFields } from './schema-fields.js';

/**
 * Canonical JSON-schema form fallback. Renders only when the A2UI
 * presentation cannot be validated; submission is always an explicit
 * user action — never an automatic approval.
 */
export function InteractionSchemaForm({
  schema,
  values,
  onChange,
  disabled,
  onSubmit,
  onCancel,
}: {
  schema: Record<string, unknown>;
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  disabled: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const fields: InteractionRequestSchemaField[] = schemaFields(schema);
  const [validationError, setValidationError] = useState('');

  return (
    <form
      className="mt-3"
      data-testid="interaction-schema-form"
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        const answered = fields.every((field) => {
          const value = values[field.name];
          return !field.required || (Array.isArray(value)
            ? value.length > 0
            : String(value ?? '').trim().length > 0);
        });
        if (!answered) {
          setValidationError('请回答必填问题后再提交。');
          return;
        }
        setValidationError('');
        onSubmit();
      }}
    >
      {fields.map((field) => (
        <div key={field.name} className="mb-2 block text-xs text-[var(--ksadk-interaction-muted)]">
          <span className="mb-1 block font-medium">
            {field.description || field.title || field.name}
            {field.required ? <span className="ml-0.5 text-rose-500">*</span> : null}
          </span>
          {field.enumValues && field.enumValues.length > 0 ? (
            <div className="space-y-1" data-testid={`interaction-field-${field.name}`}>
              {field.enumValues.map((value, index) => {
                const selected = field.type === 'array'
                  ? Array.isArray(values[field.name]) && (values[field.name] as unknown[]).includes(value)
                  : values[field.name] === value;
                return (
                  <label key={String(value)} className="flex min-h-10 cursor-pointer items-center gap-2 rounded-xl px-2 text-sm text-[var(--ksadk-interaction-foreground)] hover:bg-[var(--ksadk-interaction-muted-background)]">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--ksadk-interaction-muted-background)] text-xs text-[var(--ksadk-interaction-muted)]">{index + 1}</span>
                    <input
                      type={field.type === 'array' ? 'checkbox' : 'radio'}
                      name={field.name}
                      disabled={disabled}
                      checked={Boolean(selected)}
                      onChange={(event) => {
                        const current = Array.isArray(values[field.name]) ? values[field.name] as unknown[] : [];
                        const next = field.type === 'array'
                          ? event.target.checked ? [...current, value] : current.filter((entry) => entry !== value)
                          : value;
                        onChange({ ...values, [field.name]: next });
                      }}
                      className="h-4 w-4 accent-current"
                    />
                    <span>{String(value)}</span>
                  </label>
                );
              })}
              {field.allowOther ? (
                <input
                  aria-label={`${field.title || field.name}：自定义回答`}
                  placeholder="或填写自己的回答"
                  type={field.secret ? 'password' : 'text'}
                  disabled={disabled}
                  value={field.type === 'array'
                    ? (Array.isArray(values[field.name]) ? values[field.name] as unknown[] : []).filter((value) => !field.enumValues!.includes(value)).join('\n')
                    : field.enumValues.includes(values[field.name]) ? '' : String(values[field.name] ?? '')}
                  onChange={(event) => {
                    const custom = event.target.value;
                    const selected = (Array.isArray(values[field.name]) ? values[field.name] as unknown[] : []).filter((value) => field.enumValues!.includes(value));
                    onChange({ ...values, [field.name]: field.type === 'array' ? [...selected, ...(custom.trim() ? [custom] : [])] : custom });
                  }}
                  className="w-full rounded-lg border border-[var(--ksadk-interaction-border)] bg-[var(--ksadk-interaction-control-background)] px-3 py-2 text-sm text-[var(--ksadk-interaction-foreground)]"
                />
              ) : null}
            </div>
          ) : field.type === 'boolean' ? (
            <input
              type="checkbox"
              data-testid={`interaction-field-${field.name}`}
              disabled={disabled}
              checked={Boolean(values[field.name])}
              onChange={(event) => onChange({ ...values, [field.name]: event.target.checked })}
              className="h-4 w-4"
            />
          ) : field.type === 'number' ? (
            <input
              type="number"
              data-testid={`interaction-field-${field.name}`}
              disabled={disabled}
              value={values[field.name] === undefined ? '' : String(values[field.name])}
              onChange={(event) =>
                onChange({
                  ...values,
                  [field.name]: event.target.value === '' ? undefined : Number(event.target.value),
                })
              }
              className="w-full rounded-md border border-[var(--ksadk-interaction-border)] bg-[var(--ksadk-interaction-control-background)] px-2 py-1.5 text-sm text-foreground"
            />
          ) : (
            <input
              type={field.secret ? 'password' : 'text'}
              data-testid={`interaction-field-${field.name}`}
              disabled={disabled}
              value={String(values[field.name] ?? '')}
              onChange={(event) => onChange({ ...values, [field.name]: event.target.value })}
              className="w-full rounded-md border border-[var(--ksadk-interaction-border)] bg-[var(--ksadk-interaction-control-background)] px-2 py-1.5 text-sm text-foreground"
            />
          )}
        </div>
      ))}
      {validationError ? <p role="alert" className="mt-2 text-xs text-rose-600">{validationError}</p> : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="submit"
          data-testid="interaction-submit"
          disabled={disabled}
          className="inline-flex min-h-8 items-center rounded-md bg-[var(--ksadk-interaction-primary-background)] px-3 py-1.5 text-xs font-semibold text-[var(--ksadk-interaction-primary-foreground)] disabled:cursor-not-allowed disabled:opacity-55"
        >
          提交
        </button>
        <button
          type="button"
          data-testid="interaction-form-cancel"
          disabled={disabled}
          onClick={onCancel}
          className="inline-flex min-h-8 items-center rounded-md px-3 py-1.5 text-xs font-medium text-slate-500 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-55 dark:text-slate-400"
        >
          取消本次确认
        </button>
      </div>
    </form>
  );
}
