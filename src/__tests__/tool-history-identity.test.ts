import { describe, it, expect } from 'vitest';
import { KernelRunEventTranslator } from '../core/stream/kernel-events.js';
import { rebuildPersistedSessionHistory } from '../utils/persisted-session-history.js';
import { mapBackendMessages } from '../utils/messages.js';
import { mergeHistoryWithLive } from '../utils/transcript-order.js';
import type { Message } from '../components/chat/types.js';
import type { PersistedSessionEventRecord } from '../utils/persisted-session-history.js';
import fixture from './fixtures/tool-history-two-rounds.json';

const calls = (messages: Message[]) => messages.flatMap(message => Object.values(message.tools || {}))
  .filter(tool => tool.callId);
const callBlocks = (messages: Message[]) => messages.flatMap(message => message.blocks || [])
  .filter(block => block.type === 'tool' && block.extra?.callId);
const fallback = () => mapBackendMessages(fixture.Messages) as Message[];
const rebuild = (events: PersistedSessionEventRecord[]) => rebuildPersistedSessionHistory(
  fallback(), events, fixture.SessionId, 'agent-block-v1',
);
const records = fixture.Events as unknown as PersistedSessionEventRecord[];

describe('tool call identity across cumulative and partial history', () => {
  it('shows each observed call once before canonical history hydration', () => {
    const input = JSON.stringify(fixture.Messages);
    const messages = fallback();
    expect(calls(messages)).toHaveLength(8);
    expect(callBlocks(messages)).toHaveLength(8);
    expect(new Set(calls(messages).map(tool => tool.callId)).size).toBe(8);
    expect(calls(messages).filter(tool => tool.name === 'preview_item')).toHaveLength(2);
    expect(messages.filter(message => message.role === 'model' && message.content)).toHaveLength(3);
    expect(JSON.stringify(fixture.Messages)).toBe(input);
  });

  it.each([100, 120, 140])('retains one call row during a partial canonical window starting at seq %s', seq => {
    const output = rebuild(records.filter(row => Number(row.SeqId) >= seq));
    expect(calls(output.messages)).toHaveLength(8);
    expect(callBlocks(output.messages)).toHaveLength(8);
    expect(calls(output.messages).some(tool => tool.name === 'tool')).toBe(false);
    expect(calls(output.messages).filter(tool => tool.name === 'preview_item')).toHaveLength(2);
  });

  it('keeps the same call identities after loading full canonical history', () => {
    const output = rebuild(records);
    expect(output.canonicalRunIds).toHaveLength(2);
    expect(calls(output.messages)).toHaveLength(8);
    expect(new Set(calls(output.messages).map(tool => tool.callId)))
      .toEqual(new Set(calls(fallback()).map(tool => tool.callId)));
    expect(callBlocks(output.messages)).toHaveLength(8);
  });

  it('retains same-name calls, different runs/scopes, and calls without stable identities', () => {
    const tool = (callId?: string) => ({ Name: 'lookup', ...(callId ? { ToolCallId: callId } : {}), Status: 'completed' });
    const rows = [
      { MessageId: 'one', Role: 'assistant', InvocationId: 'one', ScopeId: 'root', ToolEvents: [tool('a'), tool('b')] },
      { MessageId: 'two', Role: 'assistant', InvocationId: 'two', ScopeId: 'root', ToolEvents: [tool('a')] },
      { MessageId: 'child', Role: 'assistant', InvocationId: 'one', ScopeId: 'child', ToolEvents: [tool('a')] },
      { MessageId: 'legacy-one', Role: 'assistant', InvocationId: 'one', ToolEvents: [tool()] },
      { MessageId: 'legacy-two', Role: 'assistant', InvocationId: 'one', ToolEvents: [tool()] },
    ];
    const result = mapBackendMessages(rows) as Message[];
    expect(result.flatMap(message => Object.values(message.tools || {}))).toHaveLength(6);
    expect(callBlocks(result)).toHaveLength(4);
  });

  it('preserves the first call position with the later durable result and both text rows', () => {
    const rows = [
      { MessageId: 'initial', Role: 'assistant', InvocationId: 'run', SeqId: 1, Content: { text: 'Progress.' },
        ToolEvents: [{ Name: 'lookup', ToolCallId: 'lookup-one', Args: { query: 'example' }, Status: 'running' }] },
      { MessageId: 'final', Role: 'assistant', InvocationId: 'run', SeqId: 2, Content: { text: 'Done.' },
        ToolEvents: [{ Name: 'lookup', ToolCallId: 'lookup-one', Result: 42, Status: 'completed' }] },
    ];
    const result = mapBackendMessages([...rows].reverse()) as Message[];
    expect(result.map(message => message.content)).toEqual(['Done.', 'Progress.']);
    expect(calls(result)).toMatchObject([{ callId: 'lookup-one', args: '{"query":"example"}', output: '42', status: 'completed' }]);
    expect(result.find(message => message.id === 'initial')?.blocks?.[0]).toMatchObject({ type: 'tool', output: '42', status: 'completed' });
    expect(result.find(message => message.id === 'final')?.blocks?.some(block => block.type === 'tool')).toBe(false);
  });

  it('does not invent a provider call from an empty native start item', () => {
    const translator = new KernelRunEventTranslator('example-session');
    const record = records.find(row => row.Content?.runtime_event?.item_kind === 'tool_call'
      && row.Content?.runtime_event?.event_type === 'item.started')!;
    expect(translator.translate({ ...record.Content!.runtime_event!, family: 'runtime', seq: record.SeqId! })).toBeNull();
  });

  it('adds separate same-name calls from a partial page without overwriting earlier calls', () => {
    const events = records.filter(row => row.InvocationId === 'run-1'
      && row.Content?.runtime_event?.item_kind === 'tool_call').map(row => {
      const frame = row.Content!.runtime_event!;
      const snapshot = frame.snapshot as { parts?: Array<Record<string, unknown>> } | undefined;
      return { ...row, Content: { runtime_event: { ...frame,
        ...(snapshot ? { snapshot: { ...snapshot, parts: snapshot.parts?.map(part => ({ ...part, name: 'lookup' })) } } : {}),
      } } };
    });
    const output = rebuildPersistedSessionHistory([
      { id: 'reply', role: 'model', content: 'Example reply.', invocationId: 'run-1', timestamp: 1 },
    ], events, 'example-session');
    expect(calls(output.messages)).toHaveLength(4);
    expect(calls(output.messages).every(tool => tool.name === 'lookup')).toBe(true);
    expect(callBlocks(output.messages)).toHaveLength(4);
  });

  it('retains the same call id in two explicit native scopes on a partial page', () => {
    const original = records.find(row => row.Content?.runtime_event?.item_kind === 'tool_call'
      && row.Content?.runtime_event?.event_type === 'item.completed')!;
    const events = ['scope-a', 'scope-b'].map((scope, index) => ({ ...original,
      SeqId: 100 + index,
      Content: { runtime_event: { ...original.Content!.runtime_event!, scope_id: scope,
        seq: 100 + index, event_id: `scope-event-${index}` } },
    }));
    const output = rebuildPersistedSessionHistory([
      { id: 'reply', role: 'model', content: 'Example reply.', invocationId: 'run-1', timestamp: 1 },
    ], events, 'example-session');
    expect(calls(output.messages)).toHaveLength(2);
    expect(callBlocks(output.messages)).toHaveLength(2);
  });

  it.each(['completed', 'error'] as const)('does not erase a %s result when only its start is loaded', status => {
    const original = records.find(row => row.Content?.runtime_event?.item_kind === 'tool_call'
      && row.Content?.runtime_event?.event_type === 'item.completed')!;
    const frame = original.Content!.runtime_event!;
    const part = (frame.snapshot as { parts: Array<{ call_id: string; name: string }> }).parts[0];
    const messages: Message[] = [{
      id: 'reply', role: 'model', content: 'Example reply.', invocationId: 'run-1', timestamp: 1,
      tools: { lookup: { name: part.name, callId: part.call_id, args: '{}', output: '42', status } },
      blocks: [{ id: 'tool', type: 'tool', toolName: part.name, args: '{}', output: '42', status,
        extra: { callId: part.call_id } }],
    }];
    const event = { ...original, EventType: 'item.started', Content: { runtime_event: {
      ...frame, event_type: 'item.started', snapshot: undefined, initial: frame.snapshot,
    } } };
    const output = rebuildPersistedSessionHistory(messages, [event], 'example-session');
    expect(calls(output.messages)).toMatchObject([{ status, output: '42' }]);
    expect(callBlocks(output.messages)).toMatchObject([{ status, output: '42' }]);
  });

  it.each([undefined, '', 0, false])('preserves missing cumulative results while accepting the JSON value %s', result => {
    const rows = [
      { MessageId: 'finished', Role: 'assistant', InvocationId: 'run', SeqId: 1,
        ToolEvents: [{ Name: 'lookup', ToolCallId: 'lookup-one', Result: 42, Status: 'completed' }] },
      { MessageId: 'later-snapshot', Role: 'assistant', InvocationId: 'run', SeqId: 2,
        ToolEvents: [{ Name: 'lookup', ToolCallId: 'lookup-one', Status: 'running',
          ...(result === undefined ? {} : { Result: result }) }] },
    ];
    const output = mapBackendMessages(rows) as Message[];
    const expected = result === undefined ? '42' : String(result);
    expect(calls(output)).toMatchObject([{ status: 'completed', output: expected }]);
    expect(callBlocks(output)).toMatchObject([{ status: 'completed', output: expected }]);
  });

  it('coalesces a cumulative call whose assistant snapshots arrive on separate message pages', () => {
    const original = records.find(row => row.Content?.runtime_event?.item_kind === 'tool_call'
      && row.Content?.runtime_event?.event_type === 'item.completed')!;
    const frame = original.Content!.runtime_event!;
    const part = (frame.snapshot as { parts: Array<{ call_id: string; name: string }> }).parts[0];
    const row = (seq: number, content: string) => ({
      MessageId: `reply-${seq}`, Role: 'assistant', InvocationId: 'run-1', SeqId: seq,
      Content: { text: content },
      ToolEvents: [{ Name: part.name, ToolCallId: part.call_id, Result: 42, Status: 'completed' }],
    });
    // loadOlderMessages maps each page independently before joining its fallback cache.
    const fallback = [...mapBackendMessages([row(10, 'Progress.')]), ...mapBackendMessages([row(30, 'Done.')])] as Message[];
    const before = JSON.stringify(fallback);
    const event = { ...original, EventType: 'item.started', Content: { runtime_event: {
      ...frame, event_type: 'item.started', snapshot: undefined, initial: frame.snapshot,
    } } };
    const output = rebuildPersistedSessionHistory(fallback, [event], 'example-session');
    expect(output.messages.map(message => message.content)).toEqual(['Progress.', 'Done.']);
    expect(calls(output.messages)).toHaveLength(1);
    expect(callBlocks(output.messages)).toHaveLength(1);
    expect(calls(output.messages)).toMatchObject([{ status: 'completed', output: '42' }]);
    expect(JSON.stringify(fallback)).toBe(before);
    expect(calls(rebuildPersistedSessionHistory(output.messages, [event], 'example-session').messages)).toHaveLength(1);
  });

  it('keeps one owner for tool facts when a compatibility card row has no assistant text', () => {
    const frames = [
      { event_type: 'run.started' },
      { event_type: 'item.started', item_id: 'call', item_kind: 'tool_call' },
      { event_type: 'item.completed', item_id: 'call', item_kind: 'tool_call',
        snapshot: { parts: [{ content_type: 'tool_call', part_id: 'args', call_id: 'call-one', name: 'preview', arguments: { enabled: false } }] } },
      { event_type: 'item.started', item_id: 'result', item_kind: 'tool_result' },
      { event_type: 'item.completed', item_id: 'result', item_kind: 'tool_result',
        snapshot: { parts: [{ content_type: 'tool_result', part_id: 'value', call_id: 'call-one', result: 0, is_error: false }] } },
      { event_type: 'run.completed' },
    ];
    const events = frames.map((frame, index) => ({
      SessionId: 'example-session', SeqId: index + 1, InvocationId: 'run-1', EventType: frame.event_type,
      Content: { runtime_event: { schema_version: 2, family: 'runtime', run_id: 'run-1',
        scope_id: 'root', event_id: `event-${index}`, seq: index + 1, timestamp: index + 1,
        source: { framework: 'langgraph' }, ...frame } },
    })) as PersistedSessionEventRecord[];
    const fallback: Message[] = [{
      id: 'compat-card', role: 'model', content: '', timestamp: 1, invocationId: 'run-1',
      aguiActivity: { surfaceId: 'display', messages: [] },
      tools: { preview: { name: 'preview', callId: 'call-one', args: '', output: '0', status: 'completed' } },
      blocks: [{ id: 'compat-tool', type: 'tool', toolName: 'preview', args: '', output: '0',
        status: 'completed', extra: { callId: 'call-one' } }],
    }];
    const before = JSON.stringify(fallback);
    const output = rebuildPersistedSessionHistory(fallback, events, 'example-session');
    expect(calls(output.messages)).toHaveLength(1);
    expect(callBlocks(output.messages)).toHaveLength(1);
    expect(output.messages.find(message => message.id === 'compat-card')?.aguiActivity?.surfaceId).toBe('display');
    expect(calls(output.messages).every(tool => tool.status === 'completed')).toBe(true);
    expect(JSON.stringify(fallback)).toBe(before);
    const hydrated = mergeHistoryWithLive(output.messages, [], [...fallback, ...output.messages.filter(message => message.id !== 'compat-card')]);
    expect(calls(hydrated)).toHaveLength(1);
    expect(callBlocks(hydrated)).toHaveLength(1);
    expect(calls(hydrated)).toMatchObject([{ status: 'completed', output: '0' }]);
  });

  it('uses an unknown legacy scope only when one native scope can own that call', () => {
    const row = (id: string, scope?: string) => ({ MessageId: id, Role: 'assistant', InvocationId: 'run',
      ...(scope ? { ScopeId: scope } : {}), ToolEvents: [{ Name: 'lookup', ToolCallId: 'call', Status: 'completed', Result: 0 }] });
    expect(calls(mapBackendMessages([row('native', 'scope-a'), row('legacy')]) as Message[])).toHaveLength(1);
    expect(calls(mapBackendMessages([row('native', 'scope-a'), row('other', 'scope-b'), row('legacy')]) as Message[])).toHaveLength(3);
  });
});
