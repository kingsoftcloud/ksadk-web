import { expect, it } from 'vitest';
import type { ApiFacade } from '../core/api/types.js';
import { prependItemHistory } from '../utils/session-items.js';

const api = {} as ApiFacade;
const scope = { HistoryEpoch: 'epoch', SnapshotSeqId: 17328 };
function event(seq: number, type: string, text: string) {
  return { ItemId: String(seq), SeqId: seq, InvocationId: 'run', EventType: type,
    Event: { EventId: String(seq), SeqId: seq, InvocationId: 'run', EventType: type,
      SessionId: 's', Content: { parts: [{ text }] } } };
}

it('reads 17,328 legacy events while projecting chat semantics only when the visible input changes', async () => {
  let state = prependItemHistory([event(17328, 'assistant_message', 'done')], api, 's', scope, 'flat-v1');
  const initial = state.semantic;
  for (let end = 17327; end > 1; end -= 50) {
    const start = Math.max(2, end - 49);
    const rows = Array.from({ length: end - start + 1 }, (_, i) => event(start + i, 'progress', 'read-' + (start + i)));
    state = prependItemHistory(rows, api, 's', scope, 'flat-v1', state);
    expect(state.semantic).toBe(initial);
  }
  state = prependItemHistory([event(1, 'user_message', 'start')], api, 's', scope, 'flat-v1', state);
  expect(state.messages.map(row => row.content)).toEqual(['start', '历史事件（17326）', 'done']);
  const details = await state.messages[1].readHistoryContent!(new AbortController().signal);
  expect(details.split('\n')).toEqual(Array.from({ length: 17326 }, (_, i) => (i + 2) + '  progress  read-' + (i + 2)));
});

it('reuses independent turns and replays across interleaved invocations or repeated event identities', () => {
  function row(seq: number, run: string, id = String(seq)) {
    const item = event(seq, 'assistant_message', 'text-' + seq);
    return { ...item, InvocationId: run, Event: { ...item.Event, EventId: id, InvocationId: run, Timestamp: 100 - seq } };
  }
  for (const rows of [
    [row(1, 'a'), row(2, 'b'), row(3, 'b'), row(4, 'c')],
    [row(1, 'a'), row(2, 'b'), row(3, 'c'), row(4, 'a')],
    [row(1, 'a', 'duplicate'), row(2, 'b'), row(3, 'c'), row(4, 'c', 'duplicate')],
  ]) {
    const read = (items: typeof rows, previous?: ReturnType<typeof prependItemHistory>) =>
      prependItemHistory(items, api, 's', scope, 'flat-v1', previous);
    const tail = read(rows.slice(2));
    const full = read(rows.slice(0, 2), tail);
    expect(full.messages).toEqual(read(rows).messages);
    if (rows[3].InvocationId === 'c' && rows[3].Event.EventId === '4') {
      expect(full.messages.at(-1)).toBe(tail.messages.at(-1));
    }
  }
});

it('compacts adjacent legacy token pages while preserving repeated tokens, snapshot boundaries', () => {
  const delta = (seq: number) => event(seq, 'assistant_stream_delta', '哈');
  let state = prependItemHistory([delta(4), delta(5)], api, 's', scope, 'flat-v1');
  state = prependItemHistory([delta(2), delta(3)], api, 's', scope, 'flat-v1', state);
  expect(state.semanticItems).toHaveLength(1);
  expect(state.messages[0].content).toBe('哈哈哈哈');
  state = prependItemHistory([event(1, 'assistant_stream_snapshot', '初始')], api, 's', scope, 'flat-v1', state);
  expect(state.semanticItems).toHaveLength(2);
  expect(state.messages[0].content).toBe('初始哈哈哈哈');
});

it('keeps old raw calls at their own positions while a tool is still running and restores each output by id', () => {
  function make(seq: number, kind: string, content: any, metadata: any = {}) {
    const item = event(seq, kind, '');
    return { ...item, Event: { ...item.Event, Content: content, Metadata: metadata, Timestamp: 100 - seq } };
  }
  const rows = [
    make(1, 'run.started', { payload: { source: 'ag-ui', input: [{ text: 'question' }] } }, { ksadk_runtime_event: true }),
    make(2, 'assistant_message', { parts: [{ text: 'first' }] }, { response_id: 'same-response' }),
    make(3, 'tool_call', { parts: [
      { functionCall: { name: 'search', id: 'one', args: { q: 'first' } } },
      { functionCall: { name: 'search', id: 'two', args: { q: 'second' } } },
    ] }),
    make(4, 'assistant_message', { parts: [{ text: 'still looking' }] }, { response_id: 'same-response' }),
  ];
  const read = (items: typeof rows) => prependItemHistory(items, api, 's', scope, 'flat-v1').messages;
  expect(read(rows).filter(row => row.content).map(row => row.content)).toEqual(['question', 'first', 'still looking']);
  const toolStates = (items: typeof rows) => read(items).flatMap(row => Object.values(row.tools || {}))
    .map(tool => [tool.name, tool.callId, tool.status, JSON.parse(tool.args).q, tool.output]);
  expect(toolStates(rows)).toEqual([
    ['search', 'one', 'running', 'first', undefined], ['search', 'two', 'running', 'second', undefined],
  ]);
  rows.push(make(5, 'tool_result', {}, { tool_receipt: { tool_call_id: 'two' }, tool_is_error: true, tool_result: 'failed' }),
    make(6, 'tool_result', { parts: [{ functionResponse: { id: 'one', response: 'found' } }] }));
  expect(toolStates(rows)).toEqual([
    ['search', 'one', 'completed', 'first', 'found'], ['search', 'two', 'error', 'second', 'failed'],
  ]);
  expect(read(rows).map(row => row.historyOrder?.seq)).toEqual([1, 2, 3, 4]);
});

it.each(['legacy', 'imported', 'canonical'])('reconciles a deferred %s result with its earlier call before loading its body', async shape => {
  const metadata = { tool_call_id: 'large', tool_name: 'lookup', tool_output: '结果'.repeat(1000) + 'END' };
  const ordinary = { SessionId: 's', EventType: 'tool_result', Metadata: metadata, Content: {} };
  const frame = { schema_version: 2, event_type: 'item.completed', item_kind: 'tool_result', item_id: 'result-id',
    scope_id: 'root', run_id: 'run', event_id: 'receipt',
    snapshot: { parts: [{ content_type: 'tool_result', call_id: 'large', result: metadata.tool_output }] } };
  const body = shape === 'imported' ? [{ session_event: { family: 'workflow', payload: { legacy_history_event: ordinary } } }, {}]
    : shape === 'canonical' ? [{ runtime_event: frame }, {}] : [{}, metadata];
  let reads = 0;
  const api = { listSessionMessages: async () => {
    reads++;
    return { HistoryView: 'items-v1', ...scope, ContentSeqId: 4, NextContentOffset: null,
      ContentChunk: JSON.stringify(body) };
  } } as unknown as ApiFacade;
  const deferred = { ...event(4, 'tool_result', ''), ContentRef: { SeqId: 4 },
    ToolRef: { CallId: 'large', Name: 'lookup', Kind: 'result' as const, Status: 'completed' as const } };
  const tail = prependItemHistory([deferred, event(5, 'assistant_message', 'done')], api, 's', scope, 'flat-v1');
  const start = { ...event(2,'tool_call',''), Event: { ...event(2, 'tool_call', '').Event,
    Metadata: { tool_call_id: 'large', tool_name: 'lookup', tool_args: { term: 'needle' } } } };
  const complete = prependItemHistory([event(1, 'user_message', 'question'), start], api,'s',scope,'flat-v1',tail);
  expect(complete.messages.map(row => row.historyOrder?.seq)).toEqual([1,2,5]);
  const tools = complete.messages.flatMap(row => Object.values(row.tools || {}));
  expect(tools).toHaveLength(1);
  expect(tools[0]).toMatchObject({ name:'lookup', callId: 'large', status:'completed', args: expect.stringContaining('needle') });
  expect(reads).toBe(0);
  await expect(tools[0].deferredOutput!.read(new AbortController().signal)).resolves.toBe(metadata.tool_output);
  expect(reads).toBe(1);
});

it('opens deferred arguments independently from the result and rejects an unrelated tool body', async () => {
  const opts = { Kind: 'call' as const, CallId: 'exact', Status: 'running' as const };
  const item = { ...event(1, 'tool_call', ''), ContentRef: { SeqId: 1 }, ToolRef: opts };
  let id = 'unrelated';
  const api = { listSessionMessages: async () => ({ ...scope, HistoryView: 'items-v1', ContentSeqId: 1,
    NextContentOffset: null, ContentChunk: JSON.stringify([{}, { tool_call_id: id, tool_args: { value: '长参数' } }]) }) } as unknown as ApiFacade;
  const state = prependItemHistory([item], api, 's', scope, 'flat-v1');
  const tool = Object.values(state.messages[0].tools!)[0];
  expect(tool.deferredOutput).toBeUndefined();
  const signal = new AbortController().signal;
  await expect(tool.deferredArgs!.read(signal)).rejects.toThrow('调用标识');
  id = 'exact';
  expect(JSON.parse(await tool.deferredArgs!.read(signal))).toEqual({ value: '长参数' });
});
