import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { JsonSchemaInputSnapshot } from '../components/chat/JsonSchemaInputForm.js';
import { InteractionHistoryAnchor } from '../components/chat/InteractionHistoryAnchor.js';
import { interactionFromSessionEvent } from '../core/interaction/adapters/session-events.js';

describe('submitted schema history', () => {
  it('keeps typed values and selections without introducing a second submit surface', () => {
    const html = renderToStaticMarkup(<JsonSchemaInputSnapshot schema={{ type: 'object', properties: {
      name: { type: 'string' }, enabled: { type: 'boolean' }, count: { type: 'integer' },
      region: { type: 'string', enum: ['east', 'west'] },
      features: { type: 'array', items: { type: 'string', enum: ['log', 'backup'] } },
      absent: { type: 'string', default: 'not-submitted' }, nullable: { type: ['string', 'null'] },
    } }} value={{ name: 'demo', enabled: false, count: 0, region: 'west', features: ['backup'], nullable: null }} />);
    expect(html).toContain('value="demo"');
    expect(html).toContain('value="0"');
    expect(html).toMatch(/<option value="false" selected=""/);
    expect(html).toMatch(/type="radio"[^>]*checked=""/);
    expect(html).toMatch(/type="checkbox"[^>]*checked=""/);
    expect(html).toContain('>null ');
    expect(html).toContain('未提供');
    expect(html).not.toContain('not-submitted');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('interaction-submit');
    expect(html).toContain('<fieldset disabled="" inert=""');
  });

  it('masks sensitive values and choices, including nested and referenced fields', () => {
    const schema = { type: 'object', $defs: { secret: { type: 'string', format: 'password' } }, properties: {
      token: { $ref: '#/$defs/secret' }, privateChoice: { type: 'boolean', writeOnly: true },
      nested: { type: 'object', properties: { key: { type: 'string', 'x-sensitive': true } } },
      ordinary: { type: 'string' },
    } };
    const html = renderToStaticMarkup(<JsonSchemaInputSnapshot schema={schema}
      value={{ token: 'fixture-private-token', privateChoice: true, nested: { key: 'fixture-key' }, ordinary: 'safe' }} />);
    expect(html.match(/已隐藏/g)).toHaveLength(3);
    expect(html).not.toContain('fixture-private-token');
    expect(html).not.toContain('fixture-key');
    expect(html).toContain('value="safe"');
    expect(html).not.toContain('type="checkbox"');
  });

  it('only renders an answer after authoritative consumption and preserves root scalar values', () => {
    const base = interactionFromSessionEvent({ family: 'interaction', session_id: 's',
      event_type: 'interaction.requested', payload: { interaction_id: 'i', kind: 'structured_input',
        request_schema: { type: 'boolean' }, title: 'Confirm input' } })!;
    const resolved = { ...base, status: 'resolved' as const, outcome: 'submitted' as const, response: false };
    const html = renderToStaticMarkup(<InteractionHistoryAnchor interaction={resolved} />);
    expect(html).toContain('interaction-input-snapshot');
    expect(html).toMatch(/<option value="false" selected=""/);
    expect(renderToStaticMarkup(<InteractionHistoryAnchor interaction={{ ...resolved, status: 'resolving' }} />))
      .not.toContain('interaction-input-snapshot');
    expect(renderToStaticMarkup(<InteractionHistoryAnchor interaction={{ ...base, status: 'resolved', outcome: 'submitted' }} />))
      .not.toContain('interaction-input-snapshot');
  });
});
