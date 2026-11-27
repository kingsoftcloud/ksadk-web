import { describe, expect, it, vi } from 'vitest';
import { listSessionMessages, readSessionMessagePage } from '../api/messages.js';
import { listSessionEvents } from '../api/events.js';
import { ApiFacadeImpl } from '../core/api/facade.js';

const page = {
  Messages: [], LatestSeqId: 12, HasMore: true, NextCursor: 7,
  DataSource: 'control_fallback', Degraded: true, CursorSource: 'control',
  CursorCompatibleWithRuntime: false, SessionContractVersion: 2,
  HistoryEpoch: 'epoch-2', PersistenceDegraded: true, SnapshotSeqId: 0,
};

describe('session message history API contract', () => {
  it('uses a smaller page when the primary response body stalls', async () => {
    vi.useFakeTimers();
    const read = vi.fn((limit: number | undefined, signal: AbortSignal | undefined) => {
      if (limit === 50) return Promise.resolve('smaller-page');
      return new Promise<string>((_, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    try {
      const result = readSessionMessagePage({ itemCursor: 'opaque', limit: 200 }, read);
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2500);
      await expect(result).resolves.toBe('smaller-page');
      expect(read.mock.calls.map(([limit]) => limit)).toEqual([200, 50]);
      expect(read.mock.calls[0]?.[1]?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start a fallback for a fast success or an immediate error', async () => {
    const read = vi.fn(async () => 'original-page');
    await expect(readSessionMessagePage({ itemCursor: 'opaque', limit: 200 }, read)).resolves.toBe('original-page');
    expect(read).toHaveBeenCalledOnce();
    read.mockRejectedValueOnce(new Error('denied'));
    await expect(readSessionMessagePage({ itemCursor: 'opaque', limit: 200 }, read)).rejects.toThrow('denied');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['hosted action', listSessionMessages],
    ['embedded facade', new ApiFacadeImpl().listSessionMessages.bind(new ApiFacadeImpl())],
  ])('%s preserves page metadata and sends the continuation contract', async (_name, read) => {
    const requests: Record<string, unknown>[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ Code: 0, Data: page }), { status: 200 });
    }) as typeof fetch;
    try {
      const result = await read('s', { beforeSeqId: 7, cursorSource: 'control', historyEpoch: 'epoch-2', snapshotSeqId: 0 });
      expect(result).toMatchObject(page);
      expect(requests[0]).toMatchObject({ BeforeSeqId: 7, CursorSource: 'control', HistoryEpoch: 'epoch-2', SnapshotSeqId: 0 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.each([
    ['hosted action', listSessionEvents],
    ['embedded facade', new ApiFacadeImpl().listSessionEvents.bind(new ApiFacadeImpl())],
  ])('%s retains event provenance and sends its own continuation contract', async (_name, read) => {
    const requests: Record<string, unknown>[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ Code: 0, Data: { Events: [], Total: 4,
        CursorSource: 'runtime', HistoryEpoch: 'event-epoch', SnapshotSeqId: 0,
        DataSource: 'runtime', SessionContractVersion: 2 } }), { status: 200 });
    }) as typeof fetch;
    try {
      const result = await read('s', { offset: 2, cursorSource: 'runtime',
        historyEpoch: 'event-epoch', snapshotSeqId: 0 });
      expect(result).toMatchObject({ CursorSource: 'runtime', HistoryEpoch: 'event-epoch', SnapshotSeqId: 0 });
      expect(requests[0]).toMatchObject({ Offset: 2, CursorSource: 'runtime',
        HistoryEpoch: 'event-epoch', SnapshotSeqId: 0 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
