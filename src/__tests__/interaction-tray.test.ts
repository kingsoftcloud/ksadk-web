import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  A2UI_WIRE_VERSION,
  computeA2uiCatalogDigest,
  validateA2uiPresentation,
} from '../core/interaction/a2ui-validate.js';
import { schemaFields } from '../components/chat/schema-fields.js';

function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    'utf-8',
  );
}

describe('InteractionTray contract', () => {
  it('renders above the composer inside ConnectedComposer', () => {
    const source = readSource('components/chat/ConnectedComposer.tsx');
    expect(source).toContain('InteractionTray');
    expect(source.indexOf('InteractionTray')).toBeLessThan(
      source.indexOf('<ChatComposer'),
    );
  });

  it('never auto-approves: every submit is an explicit user action', () => {
    const source = readSource('components/chat/InteractionTray.tsx');
    expect(source).toContain("respond('approve'");
    expect(source).toContain("respond('reject'");
    expect(source).toContain('disabled={disabled}');
    // No approval on mount or expiry.
    expect(source).not.toContain('useEffect');
  });

  it('uses the shared Interaction submit path, not protocol branches', () => {
    const source = readSource('components/chat/InteractionTray.tsx');
    expect(source).not.toContain('approvalProtocol');
    expect(source).not.toContain('mcp_approval_response');
    expect(source).not.toContain('resumeAguiInterrupt');
  });

  it('shows pending count and supports queue navigation', () => {
    const source = readSource('components/chat/InteractionTray.tsx');
    expect(source).toContain('data-testid="interaction-tray-count"');
    expect(source).toContain('data-testid="interaction-tray-prev"');
    expect(source).toContain('data-testid="interaction-tray-next"');
  });

  it('uses a compact neutral card with host-overridable style tokens', () => {
    const source = readSource('components/chat/InteractionTray.tsx');
    const styles = readSource('embed.css');
    expect(source).toContain('max-w-[64rem]');
    expect(source).toContain('data-slot="interaction-summary"');
    expect(source).toContain('--ksadk-interaction-primary-background');
    expect(source).not.toContain('bg-emerald-600');
    expect(source).toContain("active.kind === 'approval'");
    expect(styles).toContain('--ksadk-interaction-muted-background');
    expect(styles).toContain('--ksadk-interaction-focus-ring');
  });

  it('submits non-empty custom feedback with Enter outside IME composition', () => {
    const source = readSource('components/chat/InteractionTray.tsx');
    expect(source).toContain("event.key !== 'Enter'");
    expect(source).toContain('event.nativeEvent.isComposing');
    expect(source).toContain("respond('cancel', { feedback: comment.trim() })");
    expect(source).toContain("respond('submit', { value: comment.trim() })");
  });

  it('queues approval feedback as the next user turn instead of approving the old command', () => {
    const source = readSource('hooks/useAgentChat.ts');
    expect(source).toContain("input.action === 'cancel'");
    expect(source).toContain("String(input.response.feedback || '').trim()");
    expect(source).toContain("receipt.status === 'accepted' && feedback");
    expect(source).toContain('await submitDraft(feedback, [])');
  });

  it('recognises JSON-schema arrays as multi-select questions', () => {
    expect(schemaFields({
      type: 'object',
      properties: {
        checks: {
          type: 'array',
          items: { type: 'string', enum: ['单测', '端到端', '回归'] },
        },
      },
    })).toMatchObject([{
      name: 'checks',
      type: 'array',
      enumValues: ['单测', '端到端', '回归'],
    }]);
    const source = readSource('components/chat/InteractionSchemaForm.tsx');
    expect(source).toContain("field.type === 'array'");
    expect(source).toContain('type="checkbox"');
  });

  it('resolved anchors expand into a read-only snapshot with schema summary', () => {
    const source = readSource('components/chat/InteractionHistoryAnchor.tsx');
    expect(source).toContain("interaction.actor");
    expect(source).toContain('interaction-history-detail');
    expect(source).toContain('requestSchemaKeys');
    // The snapshot is never editable: no inputs, no form, no buttons.
    expect(source).not.toContain('<input');
    expect(source).not.toContain('<form');
    expect(source).not.toContain('<textarea');
    expect(source).not.toContain('<button');
  });

  it('history anchors are read-only: no buttons, retain actor/time/outcome/summary', () => {
    const source = readSource('components/chat/InteractionHistoryAnchor.tsx');
    expect(source).not.toContain('<button');
    expect(source).toContain('interaction.actor');
    expect(source).toContain('interaction.resolvedAt');
    expect(source).toContain('interaction.outcome');
    expect(source).toContain('interaction.responseSummary');
  });

  it('ChatMessageList replaces interactive history buttons with anchors when a record exists', () => {
    const source = readSource('components/chat/ChatMessageList.tsx');
    expect(source).toContain('InteractionHistoryAnchor');
    // Anchors render after the (collapsed) tool details and filter on
    // records whose id matches a tool approvalRequestId.
    const anchorIndex = source.indexOf('interactionRecords?.some');
    expect(anchorIndex).toBeGreaterThan(-1);
    // The interactive buttons only render for tools without an
    // Interaction record and only while pending.
    expect(source).toContain("tool.approvalStatus === 'pending' ? (");
  });

  it('keeps a streamed tool approval read-only once the composer tray owns it', () => {
    const source = readSource('components/chat/ProcessingBlocksView.tsx');
    expect(source).toContain('interactionRecord={record}');
    expect(source).toContain("entry.extensions.call_id");
    expect(source).toContain("status === 'error' && !cancelledByInteraction");
    expect(source).toContain('output && !cancelledByInteraction');
    expect(source).toContain("approvalStatus === 'pending' && !interactionRecord");
    expect(source).toContain('请在输入区确认面板中操作。');
  });
});

describe('A2UI v0.9.1 validation and safe fallback', () => {
  const catalog = { components: [{ id: 'root' }, { id: 'text' }] };

  it('accepts the locked wire version with a matching catalog digest', () => {
    const matching = {
      wireVersion: A2UI_WIRE_VERSION,
      catalogDigest: computeA2uiCatalogDigest(catalog),
      messages: [{ id: 'm1' }],
    };
    expect(validateA2uiPresentation(matching, catalog)).toBe('a2ui');
  });

  it('rejects unknown wire versions without ever mapping to approval', () => {
    const future = {
      wireVersion: '1.0',
      catalogDigest: 'whatever',
      messages: [{ id: 'm1' }],
    };
    expect(validateA2uiPresentation(future, catalog)).not.toBe('a2ui');
  });

  it('falls back to the JSON schema form on catalog mismatch', () => {
    const mismatch = {
      wireVersion: A2UI_WIRE_VERSION,
      catalogDigest: 'different-digest',
      messages: [{ inputSchema: { type: 'object' } }],
    };
    expect(validateA2uiPresentation(mismatch, catalog)).toBe('json-schema-form');
  });

  it('falls back to basic controls when no schema is usable', () => {
    expect(validateA2uiPresentation(null, catalog)).toBe('basic-controls');
    expect(
      validateA2uiPresentation(
        { wireVersion: A2UI_WIRE_VERSION, catalogDigest: '', messages: [] },
        catalog,
      ),
    ).toBe('basic-controls');
  });
});
