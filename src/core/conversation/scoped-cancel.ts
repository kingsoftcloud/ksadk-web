import type { ApiFacade } from '../api/types.js';
import type { AgentBlockActions, AgentCancelRequestState, AgentScopeAction } from './agent.js';
import type { ConversationItem } from './types.js';

const actionIdentity = (agentId: string, action: AgentScopeAction) =>
  JSON.stringify([agentId, action.sessionId, action.runId, action.scopeId, action.parentItemId]);

/** Deterministic across remount, refresh and retry; the server owns deduplication. */
export async function scopedCancelClientToken(agentId: string, action: AgentScopeAction): Promise<string> {
  const bytes = new TextEncoder().encode(actionIdentity(agentId, action));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return 'scope-cancel-' + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** The host supplies the current authenticated session and canonical descriptors. */
export function createScopedAgentBlockActions(options: {
  api: Pick<ApiFacade, 'cancelRun'>;
  agentId: string;
  getContext: () => { sessionId: string; supported: boolean; items: readonly ConversationItem[] };
}): AgentBlockActions {
  const pending = new Map<string, Promise<AgentCancelRequestState>>();
  const states = new Map<string, AgentCancelRequestState>();
  const authorized = (action: AgentScopeAction) => {
    const context = options.getContext();
    if (!context.supported) return 'unsupported';
    if (!action.sessionId || action.sessionId !== context.sessionId || !action.runId || !action.scopeId || !action.parentItemId) return 'unknown';
    const item = context.items.find(item => item.kind === 'agent' && item.sessionId === action.sessionId
      && item.runId === action.runId && item.payload.scope_id === action.scopeId && item.parentItemId === action.parentItemId);
    if (!item) return 'unknown';
    if ((item.payload.cancel as { capability?: string })?.capability !== 'supported') return 'unsupported';
    if (!['submitted', 'working', 'input_required'].includes(String(item.payload.status))) return 'unknown';
    return null;
  };
  return {
    getCancelRequestState: action => states.get(actionIdentity(options.agentId, action)) || 'none',
    cancel: action => {
      const key = actionIdentity(options.agentId, action);
      const rejection = authorized(action);
      if (rejection) return Promise.resolve(rejection);
      const inFlight = pending.get(key);
      if (inFlight) return inFlight;
      if (states.get(key) === 'processing' || states.get(key) === 'unsupported') return Promise.resolve(states.get(key)!);
      states.set(key, 'processing');
      const request = (async (): Promise<AgentCancelRequestState> => {
        try {
          const clientToken = await scopedCancelClientToken(options.agentId, action);
          // Session/account changes while preparing the token must not send a
          // request on behalf of a stale visible row.
          const stale = authorized(action);
          if (stale) return stale;
          const raw = await options.api.cancelRun(options.agentId, action.sessionId, action.runId, {
            scopeId: action.scopeId, clientToken,
          });
          const result = raw as { ScopeId?: string; CancelRequestState?: string } | null;
          if (result?.ScopeId !== action.scopeId) return 'unknown';
          if (result.CancelRequestState === 'unsupported') return 'unsupported';
          // Admission is not remote cancellation confirmation. Confirmation
          // and terminal status are rendered from canonical descriptors only.
          return result.CancelRequestState === 'cancel_requested' ? 'processing' : 'unknown';
        } catch {
          return 'unknown';
        }
      })().then(state => {
        states.set(key, state);
        pending.delete(key);
        return state;
      });
      pending.set(key, request);
      return request;
    },
  };
}
