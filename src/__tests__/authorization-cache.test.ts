import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthorizationCache } from '../utils/authorization-cache.js';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('authorization cache boundary', () => {
  it('retains exact legacy keys when the host does not opt in', () => {
    const cache = new AuthorizationCache();
    expect(cache.enter(undefined)).toBe('ready');
    expect(cache.key('ksadk:webui:selected-session:agent')).toBe('ksadk:webui:selected-session:agent');
  });

  it('separates opaque tenant/subject scopes without concatenation collisions', () => {
    const a = new AuthorizationCache();
    const b = new AuthorizationCache();
    a.enter('tenant:a/subject:b');
    b.enter('tenant:a%2Fsubject:b');
    expect(a.key('session')).not.toBe(b.key('session'));
    expect(a.key('session')).not.toBe('session');
    expect(a.enter('tenant:a/subject:b')).toBe('ready');
  });

  it('blocks writes and never reuses the old page after a switch or downgrade', () => {
    const cache = new AuthorizationCache();
    cache.enter('a');
    expect(cache.enter('b')).toBe('reload');
    expect(cache.writable).toBe(false);
    expect(cache.matches('a')).toBe(false);
    expect(cache.matches('b')).toBe(false);
    expect(cache.key('session')).toContain(':a:');
    expect(cache.enter('a')).toBe('reload');
    const downgrade = new AuthorizationCache();
    downgrade.enter('a');
    expect(downgrade.enter(undefined)).toBe('reload');
    expect(() => new AuthorizationCache().enter('')).toThrow();
  });

  it('does not import legacy selected session, pins or full permission into scoped identity', async () => {
    const data = new Map([
      ['ksadk:webui:selected-session:agent', 'legacy-session'],
      ['ksadk.pinnedSessionIds', '["legacy-session"]'],
      ['ksadk.web.permission-mode', 'full'],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key),
    });
    const { authorizationCache } = await import('../utils/authorization-cache.js');
    authorizationCache.enter('tenant-A');
    const sessions = await import('../utils/session.js');
    const { readPinnedSessionIds } = await import('../stores/session.js');
    const { readPermissionMode } = await import('../stores/permission.js');
    expect(sessions.readPersistedSessionId('agent', globalThis.localStorage)).toBeNull();
    expect(readPinnedSessionIds()).toEqual([]);
    expect(readPermissionMode()).toBe('risk');
    sessions.writePersistedSessionId('agent', 'a-session', globalThis.localStorage);
    expect(sessions.readPersistedSessionId('agent', globalThis.localStorage)).toBe('a-session');
    authorizationCache.enter('tenant-B');
    sessions.writePersistedSessionId('agent', 'late-response', globalThis.localStorage);
    expect(data.get(authorizationCache.key('ksadk:webui:selected-session:agent'))).toBe('a-session');
    expect(data.get('ksadk:webui:selected-session:agent')).toBe('legacy-session');
  });
});
