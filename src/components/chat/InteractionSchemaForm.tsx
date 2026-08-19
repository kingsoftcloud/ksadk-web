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

  return (
    <div className="mt-3" data-testid="interaction-schema-form">
      {fields.map((field) => (
        <label key={field.name} className="mb-2 block text-xs text-slate-600 dark:text-slate-300">
          <span className="mb-1 block font-medium">
            {field.title || field.name}
            {field.required ? <span className="ml-0.5 text-rose-500">*</span> : null}
          </span>
          {field.enumValues && field.enumValues.length > 0 ? (
            <select
              data-testid={`interaction-field-${field.name}`}
              disabled={disabled}
              value={String(values[field.name] ?? '')}
              onChange={(event) => onChange({ ...values, [field.name]: event.target.value })}
              className="w-full rounded-md border border-amber-300/70 bg-white px-2 py-1.5 text-sm dark:border-amber-900/60 dark:bg-slate-950"
            >
              <option value="">请选择…</option>
              {field.enumValues.map((value) => (
                <option key={String(value)} value={String(value)}>{String(value)}</option>
              ))}
            </select>
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
              className="w-full rounded-md border border-amber-300/70 bg-white px-2 py-1.5 text-sm dark:border-amber-900/60 dark:bg-slate-950"
            />
          ) : (
            <input
              type="text"
              data-testid={`interaction-field-${field.name}`}
              disabled={disabled}
              value={String(values[field.name] ?? '')}
              onChange={(event) => onChange({ ...values, [field.name]: event.target.value })}
              className="w-full rounded-md border border-amber-300/70 bg-white px-2 py-1.5 text-sm dark:border-amber-900/60 dark:bg-slate-950"
            />
          )}
        </label>
      ))}
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="interaction-submit"
          disabled={disabled}
          onClick={onSubmit}
          className="inline-flex min-h-8 items-center rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-55"
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
    </div>
  );
}
