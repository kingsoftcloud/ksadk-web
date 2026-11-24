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
