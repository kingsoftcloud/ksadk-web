import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { JsonSchemaInputForm, JsonSchemaInputSnapshot } from '../components/chat/JsonSchemaInputForm.js';
import { validateInput } from '../core/interaction/schema.js';

const form = (schema: Record<string, unknown>) => renderToStaticMarkup(
  <JsonSchemaInputForm schema={schema} disabled={false} onSubmit={() => {}} onCancel={() => {}} />,
);

describe('boolean property Schema JSON fallback', () => {
  const requiredAnything = {
    type: 'object', properties: { anything: true }, required: ['anything'],
  };

  it('provides an editor for a required unrestricted property', () => {
    const html = form(requiredAnything);
    expect(html).toContain('<textarea');
    expect(html).toContain('data-testid="interaction-field-value"');
    expect(validateInput(requiredAnything, {}).valid).toBe(false);
    expect(validateInput(requiredAnything, { anything: 42 }).valid).toBe(true);
  });

  it.each([null, false, 0, '', [], { nested: null }])('preserves a legal unrestricted value %j', anything => {
    expect(validateInput(requiredAnything, { anything })).toEqual({ valid: true, issues: [] });
  });

  it('does not invent values for optional forbidden properties', () => {
    const schema = { type: 'object', properties: { forbidden: false } };
    const html = form(schema);
    expect(html).toContain('<textarea');
    expect(html).toContain('>{}</textarea>');
    expect(validateInput(schema, {}).valid).toBe(true);
    expect(validateInput(schema, { forbidden: false }).valid).toBe(false);
  });

  it('keeps mixed restrictions authoritative in the fallback', () => {
    const schema = {
      type: 'object', properties: { anything: true, forbidden: false, count: { type: 'integer' } },
      required: ['anything', 'count'], additionalProperties: false,
    };
    expect(form(schema)).toContain('<textarea');
    expect(validateInput(schema, { anything: false, count: 0 }).valid).toBe(true);
    expect(validateInput(schema, { anything: false, count: 0, forbidden: null }).valid).toBe(false);
    expect(validateInput(schema, { anything: false, count: '0' }).valid).toBe(false);
  });

  it('limits fallback to the containing nested object', () => {
    const html = form({
      type: 'object', properties: {
        count: { type: 'integer' },
        options: { type: ['object', 'null'], properties: { anything: true } },
      },
    });
    expect(html).toContain('type="number"');
    expect(html).toContain('data-testid="interaction-field-count"');
    expect(html).toContain('data-testid="interaction-field-options"');
    expect(html).toContain('<textarea');
    expect(html).toContain('设为 null');
  });

  it('keeps consumed fallback snapshots read-only and secret values redacted', () => {
    const html = renderToStaticMarkup(<JsonSchemaInputSnapshot
      schema={{ type: 'object', properties: { anything: true, secret: { type: 'string', writeOnly: true } } }}
      value={{ anything: false, secret: 'FAKE-BOOLEAN-SCHEMA-SECRET' }}
    />);
    expect(html).toContain('<textarea');
    expect(html).toContain('disabled');
    expect(html).toContain('inert');
    expect(html).not.toContain('FAKE-BOOLEAN-SCHEMA-SECRET');
    expect(html).toContain('false');
    expect(html).toContain('null');
  });

  it('retains ordinary property controls', () => {
    const html = form({ type: 'object', properties: { city: { type: 'string' }, enabled: { type: 'boolean' } } });
    expect(html).toContain('data-testid="interaction-field-city"');
    expect(html).toContain('data-testid="interaction-field-enabled"');
    expect(html).not.toContain('<textarea');
  });
});
