export type InteractionRequestSchemaField = {
  name: string;
  title?: string;
  type: 'string' | 'number' | 'boolean' | 'unknown';
  required: boolean;
  enumValues?: unknown[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Extract renderable fields from a canonical JSON schema
 * (`{type:"object", properties, required}`).
 */
export function schemaFields(schema: Record<string, unknown>): InteractionRequestSchemaField[] {
  const properties = asRecord(schema.properties) || {};
  const required = Array.isArray(schema.required)
    ? new Set(schema.required.map(String))
    : new Set<string>();

  const fields: InteractionRequestSchemaField[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    const property = asRecord(raw);
    const rawType = String(property?.type || '').toLowerCase();
    const type: InteractionRequestSchemaField['type'] =
      rawType === 'string' || rawType === 'number' || rawType === 'boolean'
        ? (rawType as 'string' | 'number' | 'boolean')
        : 'unknown';
    fields.push({
      name,
      title: typeof property?.title === 'string' ? property.title : undefined,
      type,
      required: required.has(name),
      enumValues: Array.isArray(property?.enum) ? property.enum : undefined,
    });
  }
  return fields;
}
