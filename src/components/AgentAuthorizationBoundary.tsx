import { useLayoutEffect, useState, type ReactNode } from 'react';
import { authorizationCache } from '../utils/authorization-cache.js';
import { useSessionStore, readPinnedSessionIds } from '../stores/session.js';
import { usePermissionStore, readPermissionMode } from '../stores/permission.js';

export type AgentAuthorizationBoundaryProps = {
  /** Stable opaque ID from the host's authenticated principal/tenant context.
   * Persist the new login context before updating this prop; a change reloads
   * the document. Omit to preserve the legacy single-identity integration. */
  authorizationScopeKey?: string;
  children: ReactNode;
};

/** 0.3.x stores are page-wide: do not remount them under a different principal.
 * Hide the old tree before paint and reload instead. This destroys outstanding
 * requests, streams, component drafts, previews and singleton caches together.
 * Custom useAgentChat consumers must put their controller inside this boundary.
 */
export function AgentAuthorizationBoundary({ authorizationScopeKey, children }: AgentAuthorizationBoundaryProps) {
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    if (authorizationCache.enter(authorizationScopeKey) === 'reload') {
      window.location.reload();
      return;
    }
    // Stores can be imported before the authenticated host mounts the UI.
    // Re-read only this scope, never copy legacy preferences to a new identity.
    useSessionStore.setState({ pinnedSessionIds: readPinnedSessionIds() });
    usePermissionStore.setState({ permissionMode: readPermissionMode() });
    // Initial two-phase mount is intentional: children must not read stores
    // until their authenticated cache namespace has been selected.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReady(true);
  }, [authorizationScopeKey]);

  if (!ready || !authorizationCache.matches(authorizationScopeKey)) {
    return <div role="status">正在初始化会话身份…</div>;
  }
  return children;
}
