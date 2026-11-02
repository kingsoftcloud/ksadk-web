import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { A2UIActivityMessage } from '../components/chat/A2UIActivityMessage.js';
import { InteractionA2uiSurface } from '../components/chat/InteractionA2uiSurface.js';
import { InteractionHistoryAnchor } from '../components/chat/InteractionHistoryAnchor.js';
import { InteractionTray } from '../components/chat/InteractionTray.js';
import { a2uiCatalog, a2uiManifest } from '../core/a2ui/catalog.js';
import { interactionFromSessionEvent } from '../core/interaction/adapters/session-events.js';

const create = (surfaceId: string) => ({ version: 'v0.9', createSurface: {
  surfaceId, catalogId: 'a2ui.org/catalogs/basic/v1.0',
} });
const form = (surfaceId: string, label: string) => ({ version: 'v0.9', updateComponents: {
  surfaceId, components: [{ id: 'form', component: 'Form', fields: [{ name: 'value', label, type: 'string' }] }],
} });

describe('A2UI approval and surface lifecycle regressions', () => {
  it.each(['pending', 'resolving', 'failed'] as const)('keeps %s approval details once in the tray from the durable presentation', status => {
    const messages = [create('approval'), { version: 'v0.9', updateComponents: {
      surfaceId: 'approval', components: [
        { id: 'plan', component: 'Card', title: 'Review operation', body: 'Example operation details' },
        { id: 'decision', component: 'ApprovalBar', summary: 'Review before approving' },
      ],
    } }];
    const requested = interactionFromSessionEvent({ family: 'interaction', session_id: 's',
      event_type: 'interaction.requested', payload: { interaction_id: 'wait', kind: 'approval' } })!;
    const active = { ...requested, status, presentation: { a2ui: {
      wireVersion: '0.9.1', catalogDigest: a2uiManifest.catalog_digest, messages,
    } } };
    const activity = renderToStaticMarkup(<A2UIActivityMessage surfaceId="approval" messages={messages}
      boundInteraction={active} onAction={() => { throw new Error('Preview cannot submit'); }} />);
    expect(activity).toBe('');
    // No live Activity is required: ListSessionEvents restores this saved record.
    const html = renderToStaticMarkup(<InteractionTray interactions={[active]} activeIndex={0}
      onSelectIndex={() => {}} onRespond={() => {}} localCatalog={a2uiCatalog} />);
    expect(html.match(/Example operation details/g)).toHaveLength(1);
    const preview = html.slice(html.indexOf('data-testid="interaction-approval-preview"'), html.indexOf('data-testid="interaction-tray-basic"'));
    expect(preview.match(/<button/g)).toHaveLength(2);
    expect(preview.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
    expect(html.match(/data-testid="interaction-approve"/g)).toHaveLength(1);
    expect(html.match(/data-testid="interaction-reject"/g)).toHaveLength(1);
  });

  it.each(['pending', 'resolving', 'failed'] as const)('preserves %s legacy Activity details when the saved record has no A2UI', status => {
    const messages = [create('legacy-approval'), { version: 'v0.9', updateComponents: {
      surfaceId: 'legacy-approval', components: [
        { id: 'plan', component: 'Card', body: 'Legacy Activity-only plan' }, { id: 'bar', component: 'ApprovalBar' },
      ],
    } }];
    const requested = interactionFromSessionEvent({ family: 'interaction', session_id: 's',
      event_type: 'interaction.requested', payload: { interaction_id: 'old-wait', kind: 'approval' } })!;
    const html = renderToStaticMarkup(<A2UIActivityMessage surfaceId="legacy-approval" messages={messages}
      boundInteraction={{ ...requested, status }} onAction={() => { throw new Error('Preview cannot submit'); }} />);
    expect(html).toContain('Legacy Activity-only plan');
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
  });

  it.each(['approved', 'rejected'] as const)('restores the %s operation plan as read-only history and preserves later Agent results', outcome => {
    const messages = [create('approval-history'), { version: 'v0.9', updateComponents: {
      surfaceId: 'approval-history', components: [
        { id: 'plan', component: 'Card', body: 'Persisted plan in history' }, { id: 'bar', component: 'ApprovalBar' },
      ],
    } }];
    const requested = interactionFromSessionEvent({ family: 'interaction', session_id: 's',
      event_type: 'interaction.requested', payload: { interaction_id: 'history-wait', kind: 'approval' } })!;
    const record = { ...requested, status: 'resolved' as const, outcome, presentation: { a2ui: {
      wireVersion: '0.9.1', catalogDigest: a2uiManifest.catalog_digest, messages,
    } } };
    const html = renderToStaticMarkup(<InteractionHistoryAnchor interaction={record} />);
    expect(html).toContain('Persisted plan in history');
    expect(html).toContain('interaction-approval-history-preview');
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
    expect(renderToStaticMarkup(<A2UIActivityMessage surfaceId="approval-history" messages={messages} boundInteraction={record} />)).toBe('');
    const updated = [...messages, { version: 'v0.9', updateComponents: { surfaceId: 'approval-history', components: [
      { id: 'plan', component: 'Card', body: 'New Agent result' },
    ] } }];
    expect(renderToStaticMarkup(<A2UIActivityMessage surfaceId="approval-history" messages={updated} boundInteraction={record} disabled />)).toContain('New Agent result');
  });

  it('rejects an unregistered saved catalog while retaining the existing approval controls', () => {
    const requested = interactionFromSessionEvent({ family: 'interaction', session_id: 's',
      event_type: 'interaction.requested', payload: { interaction_id: 'invalid-wait', kind: 'approval' } })!;
    const html = renderToStaticMarkup(<InteractionTray interactions={[{ ...requested, presentation: { a2ui: {
      wireVersion: '0.9.1', catalogDigest: 'unknown', messages: [create('invalid'), form('invalid', 'Untrusted field')],
    } } }]} activeIndex={0} onSelectIndex={() => {}} onRespond={() => {}} />);
    expect(html).not.toContain('interaction-approval-preview');
    expect(html).not.toContain('Untrusted field');
    expect(html).toContain('interaction-approve');
    expect(html).toContain('interaction-reject');
  });

  it('renders the final live surface after deleting an earlier one', () => {
    const html = renderToStaticMarkup(<InteractionA2uiSurface a2ui={{ wireVersion: '0.9.1',
      catalogDigest: a2uiManifest.catalog_digest, messages: [
        create('old'), form('old', 'Deleted field'),
        { version: 'v0.9', deleteSurface: { surfaceId: 'old' } }, create('new'), form('new', 'New field'),
      ],
    }} disabled={false} onSubmit={() => {}} onCancel={() => {}} />);
    expect(html).toContain('New field');
    expect(html).not.toContain('Deleted field');
  });

  it('renders all live surfaces, with one shared cancel control', () => {
    const html = renderToStaticMarkup(<InteractionA2uiSurface a2ui={{ wireVersion: '0.9.1',
      catalogDigest: a2uiManifest.catalog_digest, messages: [
        create('first'), form('first', 'First field'), create('second'), form('second', 'Second field'),
      ],
    }} disabled={false} onSubmit={() => {}} onCancel={() => {}} />);
    expect(html).toContain('First field');
    expect(html).toContain('Second field');
    expect(html.match(/data-testid="interaction-a2ui-cancel"/g)).toHaveLength(1);
  });

  it('does not revive a deleted-only presentation', () => {
    const html = renderToStaticMarkup(<InteractionA2uiSurface a2ui={{ wireVersion: '0.9.1',
      catalogDigest: a2uiManifest.catalog_digest, messages: [
        create('old'), form('old', 'Deleted field'), { version: 'v0.9', deleteSurface: { surfaceId: 'old' } },
      ],
    }} disabled={false} onSubmit={() => {}} onCancel={() => {}} />);
    expect(html).toContain('卡片没有可展示的 surface');
    expect(html).not.toContain('<input');
  });
});
