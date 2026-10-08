import { describe, expect, it, vi } from 'vitest';
import { createScopedAgentBlockActions, scopedCancelClientToken } from '../core/conversation/scoped-cancel';
import type { AgentScopeAction } from '../core/conversation/agent';
import type { ConversationItem } from '../core/conversation/types';

const action: AgentScopeAction = { sessionId: 'session', runId: 'root-run', scopeId: 'child', parentItemId: 'trigger' };
const item = { kind: 'agent', sessionId: 'session', runId: 'root-run', parentItemId: 'trigger', payload: {
  scope_id: 'child', status: 'working', cancel: { capability: 'supported', request_state: 'none' },
} } as ConversationItem;
function setup(result: unknown = { ScopeId: 'child', CancelRequestState: 'cancel_requested' }) {
  const api = { cancelRun: vi.fn(async () => result) };
  const context = { sessionId: 'session', supported: true, items: [item] };
  const actions = createScopedAgentBlockActions({ api, agentId: 'agent', getContext: () => context });
  return { api, context, actions };
}
describe('host scoped cancellation', () => {
  it('deduplicates double clicks and keeps admission processing while root state is untouched', async () => {
    const { api, context, actions } = setup();
    const before = structuredClone(context);
    const first = actions.cancel!(action);
    const second = actions.cancel!(action);
    expect(first).toBe(second);
    expect(await first).toBe('processing');
    expect(api.cancelRun).toHaveBeenCalledTimes(1);
    expect(api.cancelRun).toHaveBeenCalledWith('agent', 'session', 'root-run', {
      scopeId: 'child', clientToken: await scopedCancelClientToken('agent', action),
    });
    expect(context).toEqual(before);
    expect(await actions.cancel!(action)).toBe('processing');
    expect(api.cancelRun).toHaveBeenCalledTimes(1);
  });
  it('reuses the exact token after refresh and distinguishes each target identity', async () => {
    const a = setup(); const refreshed = setup();
    await a.actions.cancel!(action); await refreshed.actions.cancel!(action);
    expect(a.api.cancelRun.mock.calls[0]).toEqual(refreshed.api.cancelRun.mock.calls[0]);
    const original = await scopedCancelClientToken('agent', action);
    for (const change of [{ sessionId: 'other' }, { runId: 'other' }, { scopeId: 'other' }, { parentItemId: 'other' }]) {
      expect(await scopedCancelClientToken('agent', { ...action, ...change })).not.toBe(original);
    }
    expect(await scopedCancelClientToken('other-account-agent', action)).not.toBe(original);
  });
  it.each([
    { supported: false }, { sessionId: 'different-session' }, { items: [] },
    { items: [{ ...item, runId: 'other-run' }] },
    { items: [{ ...item, parentItemId: 'other-trigger' }] },
  ])('rejects unsupported or stale rows without a root fallback: %j', async (change) => {
    const { context, api, actions } = setup();
    Object.assign(context, change);
    expect(await actions.cancel!(action)).toMatch(/unsupported|unknown/);
    expect(api.cancelRun).not.toHaveBeenCalled();
  });
  it('does not send when the authenticated session changes while creating the token', async () => {
    const { context, api, actions } = setup();
    const pending = actions.cancel!(action);
    context.sessionId = 'other-account-session';
    expect(await pending).toBe('unknown');
    expect(api.cancelRun).not.toHaveBeenCalled();
  });
  it.each([
    [{ ScopeId: 'child', CancelRequestState: 'unknown' }, 'unknown'],
    [{ ScopeId: 'child', CancelRequestState: 'unsupported' }, 'unsupported'],
    [{ ScopeId: 'other', CancelRequestState: 'cancel_requested' }, 'unknown'],
    [{ ScopeId: 'child', CancelRequestState: 'confirmed' }, 'unknown'],
    [{ Status: 'accepted' }, 'unknown'],
  ])('does not invent cancellation from the response %j', async (result, expected) => {
    const { actions } = setup(result);
    expect(await actions.cancel!(action)).toBe(expected);
  });
  it('retries uncertain delivery with the same token and never omits child scope', async () => {
    const { api, actions } = setup();
    api.cancelRun.mockRejectedValueOnce(new Error('connection lost'));
    expect(await actions.cancel!(action)).toBe('unknown');
    expect(await actions.cancel!(action)).toBe('processing');
    expect(api.cancelRun.mock.calls[0]).toEqual(api.cancelRun.mock.calls[1]);
  });
});
