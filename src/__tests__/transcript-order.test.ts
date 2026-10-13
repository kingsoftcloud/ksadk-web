import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mapBackendMessages } from '../utils/messages.js';
import { rebuildPersistedSessionHistory } from '../utils/persisted-session-history.js';
import { mergeHistoryWithLive, orderTranscript } from '../utils/transcript-order.js';
import type { Message } from '../components/chat/types.js';

const row = (id: string, seq: number, run: string, role = 'assistant') => ({
  MessageId: id, SeqId: seq, InvocationId: run, Role: role,
  Timestamp: 1_700_000_000_000 - seq * 1000, Content: { text: id },
});
const ids = (rows: Message[]) => rows.map(row => row.id);
const rounds = () => mapBackendMessages([
  row('q1', 1, 'r1', 'user'), row('a1', 4, 'r1'),
  row('q2', 5, 'r2', 'user'), row('a2', 8, 'r2'),
]) as Message[];

describe('transcript order independent of wall clocks', () => {
  it('keeps interleaved legacy outputs with their turn across pages and live updates', () => {
    const rows = mapBackendMessages([
      { ...row('q2', 2, 'r2', 'user'), StartSeqId: 2 },
      { ...row('a2', 8, 'r2'), StartSeqId: 2 },
      { ...row('q1', 1, 'r1', 'user'), StartSeqId: 1 },
      { ...row('a1', 7, 'r1'), StartSeqId: 1 },
    ]) as Message[];
    expect(ids(orderTranscript(rows))).toEqual(['q1', 'a1', 'q2', 'a2']);
    const baseline = orderTranscript(rows);
    const current = baseline.map(message => message.id === 'a1'
      ? { ...message, content: 'live', historyOrder: { seq: 9 } } : message);
    expect(ids(mergeHistoryWithLive(rows, baseline, current))).toEqual(['q1', 'a1', 'q2', 'a2']);
  });
  it.each(['backwards', 'equal', 'missing'])('keeps multiple rounds for %s timestamps', mode => {
    const input = rounds().map(message => ({ ...message,
      timestamp: mode === 'backwards' ? message.timestamp : mode === 'equal' ? 10 : 0 }));
    expect(ids(rebuildPersistedSessionHistory(input, [], 's').messages)).toEqual(['q1', 'a1', 'q2', 'a2']);
  });
  it('keeps the endpoint order for legacy rows without sequences', () => {
    const input = rounds().map(({ historyOrder, ...row }) => row);
    expect(ids(rebuildPersistedSessionHistory(input, [], 's').messages)).toEqual(ids(input));
  });
  it('places activities beside their owning row and keeps ordered tool blocks/call IDs', () => {
    const tools = { ...row('a1', 4, 'r1'), Blocks: [
      { Type: 'text', SeqId: 2, Content: 'before tool' },
      { Type: 'tool', SeqId: 3, Name: 'search', ToolCallId: 'call-1', Args: {}, Result: 'first' },
      { Type: 'text', SeqId: 4, Content: 'after tool' },
    ], Activities: [{ SurfaceId: 'view', Content: [{ createSurface: { surfaceId: 'view' } }] }] };
    const input = mapBackendMessages([row('q1', 1, 'r1', 'user'), tools, row('q2', 5, 'r2', 'user')]) as Message[];
    const output = rebuildPersistedSessionHistory(input, [], 's').messages;
    expect(output.map(x => x.role)).toEqual(['user', 'model', 'a2ui', 'user']);
    expect(output[1].blocks?.map(x => x.type)).toEqual(['text', 'tool', 'text']);
    expect(output[1].blocks?.[1]).toMatchObject({ extra: { previousResponseId: 'call-1' } });
  });
  it('keeps a terminal receipt after its run even if its timestamp is earlier', () => {
    const out = rebuildPersistedSessionHistory(rounds(), [{ SessionId: 's', EventId: 'failed', SeqId: 9,
      InvocationId: 'r2', Timestamp: 1, EventType: 'run_status', Content: { status: 'failed' } }], 's');
    expect(ids(out.messages)).toEqual(['q1', 'a1', 'q2', 'a2', 'failed']);
  });
  it('rejects foreign-session event rows before replay', () => {
    const out = rebuildPersistedSessionHistory(rounds(), [{ SessionId: 'other', EventId: 'foreign', SeqId: 2,
      InvocationId: 'r1', EventType: 'run_status', Content: { status: 'failed' } }], 's');
    expect(ids(out.messages)).toEqual(['q1', 'a1', 'q2', 'a2']);
  });
  it.each(['flat-v1', 'agent-block-v1'] as const)('keeps A2A rounds and child tools with reversed clocks (%s)', profile => {
    const frames = readFileSync(new URL('./fixtures/a2a_remote_agent/v1/a2a_stream_tool_terminal.jsonl', import.meta.url), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line)).filter(x => x.kind === 'runtime_event').map(x => x.payload);
    const records = [0, 1].flatMap(round => frames.map((frame, i) => ({
      SeqId: round * 1000 + i + 1, SessionId: 's', Timestamp: 1_700_000_000 - round * 100,
      Content: { runtime_event: { ...frame, run_id: `round-${round}`, session_id: 's' } },
    })));
    const result = rebuildPersistedSessionHistory([], records.reverse(), 's', profile).messages;
    const runs = result.map(message => message.invocationId);
    expect(runs).toContain('round-0'); expect(runs).toContain('round-1');
    expect(runs.slice(0, runs.indexOf('round-1')).every(run => run === 'round-0')).toBe(true);
    expect(runs.slice(runs.indexOf('round-1')).every(run => run === 'round-1')).toBe(true);
    expect(new Set(result.map(m => m.id)).size).toBe(result.length);
  });
});

describe('history/live merge', () => {
  it('keeps a streamed update in its round when an older page arrives', () => {
    const baseline = rounds().slice(2);
    const current = baseline.map(m => m.id === 'a2' ? { ...m, content: 'new streamed answer' } : m);
    const merged = mergeHistoryWithLive(rounds(), baseline, current);
    expect(ids(merged)).toEqual(['q1', 'a1', 'q2', 'a2']);
    expect(merged.at(-1)?.content).toBe('new streamed answer');
  });
  it('keeps live data newer than a fixed snapshot even when present before requesting a page', () => {
    const live = [...rounds(), { id: 'q3', role: 'user' as const, content: 'next', timestamp: 1, invocationId: 'r3' },
      { id: 'a3', role: 'model' as const, content: 'stream', timestamp: 0, invocationId: 'r3' }];
    expect(ids(mergeHistoryWithLive(rounds(), live.slice(0, 4), live))).toEqual(['q1', 'a1', 'q2', 'a2', 'q3', 'a3']);
  });
  it('uses current canonical run projection instead of adding duplicate historical output', () => {
    const baseline = rounds();
    const current = [...baseline.slice(0, 3), { id: 'canonical', role: 'model' as const, content: 'live', timestamp: 0, runId: 'r2' }];
    expect(ids(mergeHistoryWithLive(rounds(), baseline, current))).toEqual(['q1', 'a1', 'q2', 'canonical']);
  });
  it('keeps the authoritative position of an updated legacy row without a run ID', () => {
    const baseline = rounds().map(({ invocationId, ...m }) => m);
    const current = baseline.map(m => m.id === 'a1' ? { ...m, content: 'updated', historyOrder: undefined } : m);
    expect(ids(mergeHistoryWithLive(baseline, baseline, current))).toEqual(['q1', 'a1', 'q2', 'a2']);
  });
  it('keeps an unbound optimistic input before its streamed answer during paging', () => {
    const history = rounds();
    const current = [...history,
      { id: 'optimistic', role: 'user' as const, content: 'Q3', timestamp: 99, eventType: 'optimistic_user_message' },
      { id: 'stream', role: 'model' as const, content: 'A3', timestamp: 0, runId: 'r3' }];
    expect(ids(mergeHistoryWithLive(history, history, current)))
      .toEqual(['q1', 'a1', 'q2', 'a2', 'optimistic', 'stream']);
  });
  it('does not mutate the input arrays', () => {
    const input = rounds().reverse(); const before = JSON.stringify(input);
    orderTranscript(input); expect(JSON.stringify(input)).toBe(before);
  });
});
