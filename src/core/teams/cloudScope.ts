import { TeamsError } from './contracts.js';

/** Preconditions only. The authenticated Server derives and compares its own identity. */
export function cloudScopeHeaders(scope: { authorityId: string; ownerScopeRef: string }): Record<string, string> {
  if (!/^[\x21-\x7e]{1,256}$/.test(scope.authorityId) || !/^[\x21-\x7e]{1,512}$/.test(scope.ownerScopeRef)) {
    throw new TeamsError('scope_mismatch', '云端身份引用无效，请重新连接服务。');
  }
  return { 'X-Teams-Authority-Id': scope.authorityId, 'X-Teams-Owner-Scope-Ref': scope.ownerScopeRef };
}
