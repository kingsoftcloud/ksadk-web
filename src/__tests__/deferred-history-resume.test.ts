import { expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.js';
import type { ApiFacade } from '../core/api/types.js';
import { prependItemHistory } from '../utils/session-items.js';

const seq = 17;
const body = JSON.stringify([{}, { tool_call_id: 'tool-1', tool_output: '档案🌎' }]);
const parts = Array.from(body);
function fixture(fail: (offset: number) => void) {
  const offsets: number[] = [];
  const api = { listSessionMessages: async (_session: string, opts: { contentOffset: number; historyEpoch: string; snapshotSeqId: number }) => {
    const offset = opts.contentOffset;
    offsets.push(offset);
    fail(offset);
    return { HistoryView: 'items-v1', HistoryEpoch: opts.historyEpoch, SnapshotSeqId: opts.snapshotSeqId,
      ContentSeqId: seq, ContentChunk: parts[offset], NextContentOffset: offset + 1 === parts.length ? null : offset + 1 };
  } } as unknown as ApiFacade;
  function reader(session = 's', epoch = 'e', snapshot = 17, source = 'runtime') {
    const item = { SeqId: seq, EventType: 'tool_result', ItemId: 'result', InvocationId: 'run',
      ContentRef: { SeqId: seq }, ToolRef: { Kind: 'result' as const, Status: 'completed' as const, CallId: 'tool-1' },
      Event: { SeqId: seq, SessionId: session, EventId: 'result', EventType: 'tool_result', InvocationId: 'run' } };
    const result = prependItemHistory([item], api, session, { HistoryEpoch: epoch, SnapshotSeqId: snapshot, CursorSource: source }, 'flat-v1');
    return Object.values(result.messages[0].tools!)[0].deferredOutput!.read;
  }
  return { reader, offsets };
}

it('resumes at chunk 17 after disconnect without duplicating accepted chunks', async () => {
  let offline = true;
  const { reader, offsets } = fixture(offset => { if (offset === 16 && offline) throw new TypeError('offline'); });
  const checkpoint = {}, signal = new AbortController().signal;
  await expect(reader()(signal, checkpoint)).rejects.toThrow('offline');
  offline = false;
  await expect(reader()(signal, checkpoint)).resolves.toBe('档案🌎');
  expect(offsets).toEqual([...Array(16).keys(), 16, ...parts.slice(16).map((_, i) => i + 16)]);
});

it.each(['session', 'epoch', 'snapshot', 'source', 'cancel'])('discards a partial read after changing %s', async change => {
  const controller = new AbortController();
  let stop = true;
  const { reader, offsets } = fixture(offset => {
    if (stop && offset === 2) { if (change === 'cancel') controller.abort(); throw new TypeError('offline'); }
  });
  const checkpoint = {};
  await expect(reader()(controller.signal, checkpoint)).rejects.toThrow();
  stop = false;
  const read = reader(change === 'session' ? 'other' : 's', change === 'epoch' ? 'new' : 'e', change === 'snapshot' ? 19 : 17, change === 'source' ? 'other' : 'runtime');
  await expect(read(new AbortController().signal, checkpoint)).resolves.toBe('档案🌎');
  expect(offsets[3]).toBe(0);
});

it('backs off a bounded number of times on 429 and leaves a manual retry at the same offset', async () => {
  vi.useFakeTimers();
  try {
    let throttle = true;
    const { reader, offsets } = fixture(offset => { if (offset === 16 && throttle) throw new ApiError(429, 'rate limit'); });
    const checkpoint = {}, signal = new AbortController().signal;
    const failure = expect(reader()(signal, checkpoint)).rejects.toThrow('rate limit');
    await vi.runAllTimersAsync(); await failure;
    expect(offsets.filter(offset => offset === 16).length).toBe(4);
    throttle = false;
    await expect(reader()(signal, checkpoint)).resolves.toBe('档案🌎');
    expect(offsets.filter(offset => offset === 0)).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});

it('honors Retry-After and aborts the backoff without fetching a stale chunk', async () => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    const checkpoint = {};
    let throttle = true;
    const { reader, offsets } = fixture(offset => { if (offset === 2 && throttle) throw new ApiError(429, 'wait', {}, '4'); });
    const pending = expect(reader()(controller.signal, checkpoint)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(3999);
    expect(offsets).toEqual([0, 1, 2]);
    controller.abort();
    await pending;
    throttle = false;
    await expect(reader()(new AbortController().signal, checkpoint)).resolves.toBe('档案🌎');
    expect(offsets[3]).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
