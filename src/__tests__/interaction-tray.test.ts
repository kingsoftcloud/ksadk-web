import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  A2UI_WIRE_VERSION,
  computeA2uiCatalogDigest,
  validateA2uiPresentation,
} from '../core/interaction/a2ui-validate.js';

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
