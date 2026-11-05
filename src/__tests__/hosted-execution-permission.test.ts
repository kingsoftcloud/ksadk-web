import { describe, expect, it } from 'vitest';

import { normalizeCapabilities } from '../utils/capabilities.js';
import {
  EXECUTION_PERMISSION_MODES,
  executionPermissionMetadata,
  normalizeExecutionModes,
  resolveExecutionMode,
} from '../stores/execution-permission.js';
import { permissionMenuVisible } from '../components/chat/permission-menu-visibility.js';

function capabilities(overrides: Record<string, unknown>) {
  return normalizeCapabilities({ Data: { Capabilities: overrides } });
}

describe('Hosted execution permission capability', () => {
  it('accepts exactly the three sandbox tiers the runtime declares', () => {
    const normalized = capabilities({
      ExecutionPolicy: {
        Modes: ['workspace-write', 'read-only', 'workspace-write', 'full'],
        DefaultMode: 'workspace-write',
      },
    });

    expect(normalized.ExecutionPolicy).toEqual({
      Modes: ['workspace-write', 'read-only'],
      DefaultMode: 'workspace-write',
    });
  });

  it('never invents a policy when the runtime declares none', () => {
    expect(capabilities({}).ExecutionPolicy).toBeNull();
    expect(capabilities({ ExecutionPolicy: { Modes: [] } }).ExecutionPolicy).toBeNull();
    expect(capabilities({ ExecutionPolicy: { Modes: ['full'] } }).ExecutionPolicy).toBeNull();
  });

  it('keeps the approval policy separate and fixed when the host disables selection', () => {
    const normalized = capabilities({
      ApprovalPolicy: { Modes: ['risk'], DefaultMode: 'risk', RuntimeOverride: true, Selectable: false },
    });

    expect(normalized.ApprovalPolicy).toEqual({
      Modes: ['risk'],
      DefaultMode: 'risk',
      RuntimeOverride: true,
      Selectable: false,
    });
    expect(permissionMenuVisible(normalized.ApprovalPolicy)).toBe(false);
  });
});

describe('execution permission selection', () => {
  const policy = { Modes: ['read-only', 'workspace-write', 'danger-full-access'], DefaultMode: 'workspace-write' } as const;

  it('prefers the persisted tier while it is still declared', () => {
    expect(resolveExecutionMode(policy, 'read-only')).toBe('read-only');
  });

  it('falls back to the runtime default and cleans a stale tier', () => {
    expect(resolveExecutionMode(policy, 'full')).toBe('workspace-write');
    expect(resolveExecutionMode({ Modes: ['read-only'] } as never, 'workspace-write')).toBe('read-only');
    expect(resolveExecutionMode(null, 'read-only')).toBeUndefined();
    expect(normalizeExecutionModes(policy)).toEqual([...EXECUTION_PERMISSION_MODES]);
  });

  it('only carries the tier into RunAgent metadata when one is resolved', () => {
    expect(executionPermissionMetadata('danger-full-access')).toEqual({
      permission_mode: 'danger-full-access',
    });
    expect(executionPermissionMetadata(undefined)).toEqual({});
  });
});

describe('approval menu visibility', () => {
  it('hides a fixed or single-mode approval policy and keeps legacy two-mode hosts', () => {
    expect(permissionMenuVisible({ Modes: ['risk'], DefaultMode: 'risk', RuntimeOverride: true, Selectable: false })).toBe(false);
    expect(permissionMenuVisible({ Modes: ['risk'], DefaultMode: 'risk', RuntimeOverride: true })).toBe(false);
    expect(permissionMenuVisible({ Modes: ['ask', 'risk'], DefaultMode: 'risk', RuntimeOverride: true })).toBe(true);
    expect(permissionMenuVisible(undefined)).toBe(true);
  });
});
