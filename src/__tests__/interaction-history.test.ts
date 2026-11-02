import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../components/chat/types.js';
import type { ApiFacade } from '../core/api/types.js';
import { interactionFromSessionEvent } from '../core/interaction/adapters/session-events.js';
import { InteractionStore } from '../core/interaction/store.js';
import { hydrateVisibleInteractionHistory } from '../utils/interaction-history.js';

const sessionId = 'session';
const request = (id = 'wait', seq = 158) => ({ SessionId: sessionId, SeqId: seq,
  EventType: 'interaction.requested', InvocationId: 'run', Content: {
    interaction_id: id, kind: 'structured_input', revision: 1,
    request: { request_schema: { type: 'object', required: ['resource'] },
      presentation: { title: '补充资源参数', description: '请选择资源', a2ui: {
        wire_version: '0.9.1', catalog_digest: 'digest', messages: [{ createSurface: { surfaceId: 'form' } }],
      } } },
  } });
const resolved = (id = 'wait', seq = 289) => ({ SessionId: sessionId, SeqId: seq,
  EventType: 'interaction.resolved', InvocationId: 'run', Content: {
    interaction_id: id, kind: 'structured_input', revision: 2, outcome: 'submitted', actor: 'user',
  } });
const message = (id = 'wait', group = 128): Message => ({ id: `message-${id}`, role: 'model', content: '',
  timestamp: 1, historyOrder: { seq: 291, group }, tools: { input: {
    name: 'structured_input', args: '', status: 'completed', approvalRequestId: id,
  } } });
const snapshot = { CursorSource: 'runtime', HistoryEpoch: 'epoch', SnapshotSeqId: 293 };
const initial = { ...snapshot, Events: [resolved()], Total: 293 };

describe('bounded visible interaction metadata', () => {
  it('restores a request older than the transcript detail window without adding unrelated waits', async () => {
    const listSessionEvents = vi.fn().mockResolvedValue({ ...snapshot,
      Events: [resolved(), request(), request('unrelated', 150)], Total: 3, HasMore: false });
    const result = await hydrateVisibleInteractionHistory({ listSessionEvents } as unknown as ApiFacade,
      sessionId, [message()], initial, () => true);
    expect(result.incomplete).toBe(false);
    expect(result.events.map(row => row.SeqId)).toEqual([289, 158]);
    expect(listSessionEvents).toHaveBeenCalledExactlyOnceWith(sessionId, expect.objectContaining({
      eventTypes: expect.arrayContaining(['interaction.requested', 'interaction.resolved']), limit: 32,
      afterSeqId: 127, beforeSeqId: 294, cursorSource: 'runtime', historyEpoch: 'epoch', snapshotSeqId: 293,
    }));
  });

  it('stops after finding visible requests even when unrelated older metadata remains', async () => {
    const listSessionEvents = vi.fn().mockResolvedValue({ ...snapshot, Events: [resolved(), request()], HasMore: true });
    const result = await hydrateVisibleInteractionHistory({ listSessionEvents } as unknown as ApiFacade,
      sessionId, [message()], initial, () => true);
    expect(result.incomplete).toBe(false);
    expect(listSessionEvents).toHaveBeenCalledTimes(1);
  });

  it('advances only a dedicated metadata cursor and reports the fixed budget as incomplete', async () => {
    const listSessionEvents = vi.fn()
      .mockResolvedValueOnce({ ...snapshot, Events: [request('other', 200)], HasMore: true })
      .mockResolvedValueOnce({ ...snapshot, Events: [request('other-2', 180)], HasMore: true });
    const result = await hydrateVisibleInteractionHistory({ listSessionEvents } as unknown as ApiFacade,
      sessionId, [message()], initial, () => true);
    expect(result).toEqual({ events: [], incomplete: true });
    expect(listSessionEvents).toHaveBeenCalledTimes(2);
    expect(listSessionEvents.mock.calls[1]?.[1]).toMatchObject({ beforeSeqId: 200, afterSeqId: 127, snapshotSeqId: 293 });
    expect(initial.Events).toEqual([resolved()]);
    expect(initial.Total).toBe(293);
  });

  it('uses the newly loaded older message range', async () => {
    const listSessionEvents = vi.fn().mockResolvedValue({ ...snapshot, Events: [request('old', 60)], HasMore: false });
    await hydrateVisibleInteractionHistory({ listSessionEvents } as unknown as ApiFacade,
      sessionId, [message('old', 50)], initial, () => true);
    expect(listSessionEvents.mock.calls[0]?.[1]).toMatchObject({ afterSeqId: 49 });
  });

  it.each([{ HistoryEpoch: 'changed' }, { SnapshotSeqId: 294 }, { CursorSource: 'control' }])(
    'rejects a changed snapshot without returning metadata (%j)', async changed => {
      const listSessionEvents = vi.fn().mockResolvedValue({ ...snapshot, ...changed, Events: [request()], HasMore: false });
      await expect(hydrateVisibleInteractionHistory({ listSessionEvents } as unknown as ApiFacade,
        sessionId, [message()], initial, () => true)).rejects.toThrow('snapshot changed');
    });

  it('drops a late metadata response after navigation or cancellation', async () => {
    let current = true;
    const listSessionEvents = vi.fn(async () => { current = false; return { ...snapshot, Events: [request()] }; });
    expect(await hydrateVisibleInteractionHistory({ listSessionEvents } as unknown as ApiFacade,
      sessionId, [message()], initial, () => current)).toEqual({ events: [], incomplete: true });
  });

  it('preserves the legacy path and avoids an extra read when the request is already loaded', async () => {
    const listSessionEvents = vi.fn();
    const api = { listSessionEvents } as unknown as ApiFacade;
    await hydrateVisibleInteractionHistory(api, sessionId, [message()], { Events: [] }, () => true);
    await hydrateVisibleInteractionHistory(api, sessionId, [message()], { ...initial, Events: [request(), resolved()] }, () => true);
    expect(listSessionEvents).not.toHaveBeenCalled();
  });
});

describe('terminal-first interaction replay', () => {
  it('fills the original request snapshot without reopening or expiring a consumed answer', () => {
    const store = new InteractionStore();
    store.markRunTerminal(sessionId, 'run');
    store.upsert(interactionFromSessionEvent(resolved())!);
    store.upsert(interactionFromSessionEvent(request())!);
    expect(store.get(sessionId, 'wait')).toMatchObject({ status: 'resolved', outcome: 'submitted', revision: 2,
      title: '补充资源参数', message: '请选择资源', kind: 'structured_input',
      requestSchema: { type: 'object', required: ['resource'] },
      presentation: { a2ui: { wireVersion: '0.9.1', catalogDigest: 'digest' } },
    });
    expect(store.listPending(sessionId)).toEqual([]);
  });

  it('preserves an existing request snapshot and cancelled decision on duplicate replay', () => {
    const store = new InteractionStore();
    const original = interactionFromSessionEvent(request())!;
    store.upsert(original);
    store.upsert({ ...original, revision: 2, status: 'cancelled', outcome: 'cancelled' });
    store.upsert({ ...original, title: 'stale title', message: 'stale message', presentation: null });
    expect(store.get(sessionId, 'wait')).toMatchObject({ title: '补充资源参数', message: '请选择资源',
      revision: 2, status: 'cancelled', outcome: 'cancelled', presentation: original.presentation });
  });
});
