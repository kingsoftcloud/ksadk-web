import { describe, expect, it } from 'vitest';
import {
  createSessionEventCursor,
  loadCompleteSessionEventHistory,
  resolveOlderSessionEventPage,
} from '../utils/session-event-history.js';

function makeEvents(total: number) {
  return Array.from({ length: total }, (_, index) => ({
    EventId: `evt-${index + 1}`,
    SeqId: index + 1,
    Timestamp: index + 1,
    EventType: index === 0 || index === 189 ? 'user_message' : 'reasoning',
  }));
}

describe('session event history loading', () => {
  it('loads every event page for selected sessions so history is not rebuilt from a truncated tail page', async () => {
    const sourceEvents = makeEvents(306);
    const calls: Array<{ offset?: number; limit?: number }> = [];

    const result = await loadCompleteSessionEventHistory(
      'session-1',
      async (_sessionId, opts) => {
        calls.push({ offset: opts?.offset, limit: opts?.limit });
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? sourceEvents.length;
        const end = Math.max(sourceEvents.length - offset, 0);
        const start = Math.max(end - limit, 0);
        return {
          Events: sourceEvents.slice(start, end),
          Total: sourceEvents.length,
          Offset: offset,
          Limit: limit,
        };
      },
      { pageSize: 50 },
    );

    expect(result?.events.map((event) => event.SeqId)).toEqual(
      sourceEvents.map((event) => event.SeqId),
    );
    expect(result?.total).toBe(306);
    expect(calls).toEqual([
      { offset: 0, limit: 50 },
      { offset: 50, limit: 50 },
      { offset: 100, limit: 50 },
      { offset: 150, limit: 50 },
      { offset: 200, limit: 50 },
      { offset: 250, limit: 50 },
      { offset: 300, limit: 6 },
    ]);
    expect(result?.offset).toBe(306);
  });

  it('stops without returning partial history when the selected session changes mid-load', async () => {
    const sourceEvents = makeEvents(120);
    let calls = 0;

    const result = await loadCompleteSessionEventHistory(
      'session-1',
      async (_sessionId, opts) => {
        calls += 1;
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? sourceEvents.length;
        const end = Math.max(sourceEvents.length - offset, 0);
        const start = Math.max(end - limit, 0);
        return {
          Events: sourceEvents.slice(start, end),
          Total: sourceEvents.length,
          Offset: offset,
          Limit: limit,
        };
      },
      {
        pageSize: 50,
        shouldContinue: () => calls < 1,
      },
    );

    expect(result).toBeNull();
    expect(calls).toBe(1);
  });

  it('requests the next older page by skipping already loaded latest events', () => {
    expect(resolveOlderSessionEventPage({ offset: 50, total: 306 }, 50)).toEqual({
      offset: 50,
      limit: 50,
    });
    expect(resolveOlderSessionEventPage({ offset: 300, total: 306 }, 50)).toEqual({
      offset: 300,
      limit: 6,
    });
    expect(resolveOlderSessionEventPage({ offset: 306, total: 306 }, 50)).toBeNull();
  });
});

function kernelEvent(seq: number, extra: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    event_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    session_id: 'session-1',
    seq,
    timestamp: '2026-08-17T00:00:01Z',
    family: 'runtime',
    family_version: 2,
    event_type: 'run.message.delta',
    payload: { seq },
    ...extra,
  };
}

describe('SessionEventCursor (agent-kernel/v1)', () => {
  it('dedupes and orders strictly by session seq', () => {
    const cursor = createSessionEventCursor();
    cursor.accept(kernelEvent(3));
    cursor.accept(kernelEvent(1));
    cursor.accept(kernelEvent(2));
    cursor.accept(kernelEvent(2)); // exact duplicate is ignored
    expect(cursor.displayableEvents().map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(cursor.lastSeq).toBe(3);
  });

  it('keeps unknown event families out of display but advances the cursor', () => {
    const cursor = createSessionEventCursor();
    cursor.accept(kernelEvent(1));
    cursor.accept(kernelEvent(2, { family: 'workflow', event_type: 'step.started' }));
    cursor.accept(kernelEvent(3));
    expect(cursor.displayableEvents().map((event) => event.seq)).toEqual([1, 3]);
    expect(cursor.lastSeq).toBe(3);
  });

  it('replays refresh results before live events without duplicating seqs', () => {
    const cursor = createSessionEventCursor();
    cursor.accept(kernelEvent(1));
    cursor.accept(kernelEvent(2));
    // Simulated refresh replay overlapping the live tail.
    cursor.accept(kernelEvent(2));
    cursor.accept(kernelEvent(3));
    expect(cursor.displayableEvents().map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it('reconnects from the last session seq', () => {
    const cursor = createSessionEventCursor();
    cursor.accept(kernelEvent(41));
    cursor.accept(kernelEvent(42));
    expect(cursor.reconnectAfterSeq()).toBe(42);
  });
});
