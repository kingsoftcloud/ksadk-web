import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useExecutionPermissionStore, executionPermissionMetadata } from '../stores/execution-permission.js';
import { useBootstrapStore } from '../stores/bootstrap.js';
import { normalizeCapabilities } from '../utils/capabilities.js';
import { authorizationCache } from '../utils/authorization-cache.js';

const policy = { Modes: ['read-only', 'danger-full-access'], DefaultMode: 'read-only' } as const;
let persisted: Map<string, string>;
const permission = () => useExecutionPermissionStore.getState();
function capabilities(value: unknown) {
  useBootstrapStore.getState().setCapabilities(normalizeCapabilities({ Data: { Capabilities: { ExecutionPolicy: value } } }));
}

beforeEach(() => {
  persisted = new Map();
  vi.stubGlobal('localStorage', { getItem: (k: string) => persisted.get(k) ?? null,
    setItem: (k: string, v: string) => persisted.set(k, v), removeItem: (k: string) => persisted.delete(k) });
  Object.assign(authorizationCache, { initialized: false, scope: undefined, blocked: false });
  authorizationCache.enter('test-owner');
  useBootstrapStore.getState().setAgentId('agent-a');
  permission().configure('agent-a', null);
});
afterEach(() => { vi.unstubAllGlobals(); Object.assign(authorizationCache, { initialized: false, scope: undefined, blocked: false }); });

describe('execution permission revocation without a mounted menu', () => {
  it.each([null, undefined, { Modes: [] }, { Modes: ['unknown'] }])('clears memory and scoped persistence for %j', value => {
    capabilities(policy);
    permission().select('agent-a', 'danger-full-access');
    expect(permission().modeFor('agent-a')).toBe('danger-full-access');
    capabilities(value);
    expect(permission().modeFor('agent-a')).toBeUndefined();
    expect(executionPermissionMetadata(permission().modeFor('agent-a'))).toEqual({});
    expect([...persisted.values()]).toEqual([]);
  });

  it('rejects a stale selection and does not modify another Agent', () => {
    capabilities(policy);
    permission().select('agent-a', 'danger-full-access');
    permission().configure('agent-b', { Modes: ['workspace-write'] });
    capabilities({ Modes: ['read-only'] });
    permission().select('agent-a', 'danger-full-access');
    expect(permission().modeFor('agent-a')).toBe('read-only');
    expect(permission().modeFor('agent-b')).toBe('workspace-write');
    capabilities(null);
    expect(permission().modeFor('agent-b')).toBe('workspace-write');
  });

  it('restores only a still-declared saved value', () => {
    const key = authorizationCache.key('ksadk.web.execution-permission.agent-a');
    persisted.set(key, 'danger-full-access');
    capabilities(policy);
    expect(permission().modeFor('agent-a')).toBe('danger-full-access');
    capabilities({ Modes: ['read-only'] });
    expect(persisted.get(key)).toBe('read-only');
  });

  it('keeps a valid memory choice when storage is unavailable, but revokes it immediately', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } });
    capabilities(policy);
    permission().select('agent-a', 'danger-full-access');
    capabilities(policy);
    expect(permission().modeFor('agent-a')).toBe('danger-full-access');
    capabilities(null);
    expect(permission().modeFor('agent-a')).toBeUndefined();
  });

  it('does not send a selection after the authorization scope has changed', () => {
    capabilities(policy);
    permission().select('agent-a', 'danger-full-access');
    expect(authorizationCache.enter('another-owner')).toBe('reload');
    expect(permission().modeFor('agent-a')).toBeUndefined();
    expect([...persisted.values()]).toEqual(['danger-full-access']);
  });
});
