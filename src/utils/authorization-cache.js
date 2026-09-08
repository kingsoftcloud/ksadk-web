/** UI cache namespace only. Never use this value as authorization evidence. */
export class AuthorizationCache {
  initialized = false;
  /** @type {string | undefined} */
  scope;
  blocked = false;

  /** @param {string | undefined} scope */
  enter(scope) {
    if (scope !== undefined && !scope.trim()) throw new Error('authorizationScopeKey must be non-empty');
    if (this.blocked) return 'reload';
    if (this.initialized && this.scope !== scope) {
      this.blocked = true;
      return 'reload';
    }
    this.initialized = true;
    this.scope = scope;
    return 'ready';
  }

  /** @param {string | undefined} scope */
  matches(scope) {
    return this.initialized && !this.blocked && this.scope === scope;
  }

  key(legacyKey) {
    return this.scope === undefined ? legacyKey
      : `ksadk:authorization:${encodeURIComponent(this.scope)}:${legacyKey}`;
  }

  get writable() { return !this.blocked; }
}

export const authorizationCache = new AuthorizationCache();
