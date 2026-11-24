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
