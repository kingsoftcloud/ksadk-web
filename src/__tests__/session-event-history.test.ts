import { describe, expect, it } from 'vitest';
import {
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
      { offset: 0, limit: 1 },
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
        shouldContinue: () => calls < 2,
      },
    );

    expect(result).toBeNull();
    expect(calls).toBe(2);
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
