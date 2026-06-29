import { describe, expect, it } from 'vitest';
import { loadCompleteSessionEventHistory } from '../utils/session-event-history.js';

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
        return {
          Events: sourceEvents.slice(offset, offset + limit),
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
    expect(result?.offset).toBe(0);
    expect(result?.total).toBe(306);
    expect(calls).toEqual([
      { offset: 0, limit: 1 },
      { offset: 256, limit: 50 },
      { offset: 206, limit: 50 },
      { offset: 156, limit: 50 },
      { offset: 106, limit: 50 },
      { offset: 56, limit: 50 },
      { offset: 6, limit: 50 },
      { offset: 0, limit: 6 },
    ]);
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
        return {
          Events: sourceEvents.slice(offset, offset + limit),
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
});
