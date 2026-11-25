import { expect, it } from 'vitest';
import type { ApiFacade } from '../core/api/types.js';
import type { SessionHistoryItem } from '../api/messages.js';
import { prependItemHistory } from '../utils/session-items.js';

it('retains each prompt, tool result and reply across 4,332 turns in physical sequence order', () => {
  const items: SessionHistoryItem[] = [];
  const expected: unknown[][] = [];
  const kinds = ['user_message', 'tool_call', 'tool_result', 'assistant_message'];
  for (let turn = 1; turn <= 4332; turn++) {
    const run = 'run-' + turn;
    for (const [index, kind] of kinds.entries()) {
      const seq = items.length + 1;
      const text = index === 0 ? 'prompt-' + turn : index === 3 ? 'reply-' + turn : '';
      const metadata = index === 1
        ? { tool_name: 'lookup', tool_call_id: run, tool_args: { turn } }
        : index === 2 ? { tool_name: 'lookup', tool_call_id: run, tool_output: 'result-' + turn } : {};
      items.push({ ItemId: String(seq), SeqId: seq, InvocationId: run, EventType: kind,
        Event: { EventId: String(seq), SeqId: seq, SessionId: 'dense', InvocationId: run,
          EventType: kind, Timestamp: 20000 - seq, Author: index === 0 ? 'user' : 'assistant',
          Content: { parts: text ? [{ text }] : [] }, Metadata: metadata } });
      if (index === 1) expected.push([seq, run, turn, 'result-' + turn, 'completed']);
      else if (text) expected.push([seq, text]);
    }
  }
  const scope = { HistoryEpoch: 'dense-fixture', SnapshotSeqId: items.length };
  let history: ReturnType<typeof prependItemHistory> | undefined;
  for (let end = items.length; end > 0; end -= 50) {
    history = prependItemHistory(items.slice(Math.max(0, end - 50), end),
      {} as ApiFacade, 'dense', scope, 'flat-v1', history);
  }
  const actual = history!.messages.map(row => {
    const tool = Object.values(row.tools || {})[0];
    return tool
      ? [row.historyOrder?.seq, tool.callId, JSON.parse(tool.args).turn, tool.output, tool.status]
      : [row.historyOrder?.seq, row.content];
  });
  expect(actual).toEqual(expected);
}, 90_000);

it('keeps repeated prompts, attachments and reversed same-name tool results with their own turn across pages', () => {
  const items: SessionHistoryItem[] = [];
  for (const run of ['first', 'second', 'third']) {
    const add = (type: string, content: SessionHistoryItem['Event']['Content'], metadata = {}) => {
      const seq = items.length + 1;
      items.push({ ItemId: String(seq), SeqId: seq, InvocationId: run, EventType: type,
        Event: { EventId: 'event-' + seq, SeqId: seq, SessionId: 'repeat', InvocationId: run,
          Timestamp: 100 - seq, EventType: type, Content: content, Metadata: metadata } });
    };
    add('user_message', { parts: [{ text: 'check this file' }, { type: 'input_file',
      fileData: { fileUri: 'file:///' + run + '.txt', displayName: run + '.txt', mimeType: 'text/plain' } }] });
    for (const key of ['A', 'B']) add('tool_call', {}, { tool_name: 'lookup', tool_call_id: key, tool_args: { run, key } });
    for (const key of ['B', 'A']) add('tool_result', {}, { tool_name: 'lookup', tool_call_id: key, tool_output: run + key });
    add('assistant_message', { parts: [{ text: 'done' }] });
  }
  const read = (rows: SessionHistoryItem[], previous?: ReturnType<typeof prependItemHistory>) =>
    prependItemHistory(rows, {} as ApiFacade, 'repeat', { HistoryEpoch: 'repeat', SnapshotSeqId: items.length }, 'flat-v1', previous);
  let paged: ReturnType<typeof read> | undefined;
  for (let end = items.length; end > 0; end -= 4) paged = read(items.slice(Math.max(0, end - 4), end), paged);
  const rows = paged!.messages;
  expect(rows).toEqual(read(items).messages);
  for (const run of ['first', 'second', 'third']) {
    const turn = rows.filter(message => message.invocationId === run);
    expect(turn.map(message => message.content)).toEqual(['check this file', '', '', 'done']);
    expect(turn[0].attachments?.map(file => file.name)).toEqual([run + '.txt']);
    const tools = turn.flatMap(message => Object.values(message.tools || {}));
    expect(tools.map(tool => [tool.name, tool.callId, JSON.parse(tool.args), tool.output])).toEqual(
      ['A', 'B'].map(key => ['lookup', key, { run, key }, run + key]));
  }
});
