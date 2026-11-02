import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpAgent, type AgentSubscriber } from '@ag-ui/client';
import { AguiRunClient } from '../core/run/agui.js';
import { dispatchRunEventToStores } from '../core/run/dispatcher.js';
import { appendTextBlock, replaceTextBlocks, type ProcessingBlock } from '../core/run/blocks.js';
import type { RunEvent } from '../core/run/types.js';
import { useMessageStore } from '../stores/message.js';
import { useSessionStore } from '../stores/session.js';

const snapshot = (content: string, changes: Record<string, unknown> = {}) => ({ type: 'CUSTOM', name: 'ksadk.text_message_snapshot',
  value: { version: 1, threadId: 's', runId: 'r', messageId: 'm', content, ...changes } });
const sse = (events: Record<string, unknown>[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
  headers: { 'content-type': 'text/event-stream' },
});
const start = (runId = 'r') => ({ type: 'RUN_STARTED', threadId: 's', runId });
const end = (runId = 'r') => ({ type: 'RUN_FINISHED', threadId: 's', runId, outcome: { type: 'success' } });

afterEach(() => vi.restoreAllMocks());

it.each(['Corrected', 'Old', ''])('updates the real HttpAgent message without dropping tool calls or prior messages: %j', async content => {
  const bodies: Record<string, unknown>[] = [];
  const events: RunEvent[] = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return bodies.length === 1 ? sse([start(),
      { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'Old draft' },
      { type: 'TOOL_CALL_START', toolCallId: 'lookup', toolCallName: 'lookup', parentMessageId: 'm' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'lookup', delta: '{}' }, { type: 'TOOL_CALL_END', toolCallId: 'lookup' },
      { type: 'TOOL_CALL_RESULT', messageId: 'lookup-result', toolCallId: 'lookup', role: 'tool', content: 'kept' },
      { type: 'ACTIVITY_SNAPSHOT', messageId: 'card', activityType: 'a2ui-surface', content: { surfaceId: 'card', content: [] } },
      snapshot(content), { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: '!' },
      { type: 'TEXT_MESSAGE_END', messageId: 'm' }, end(),
    ]) : sse([start('next'), end('next')]);
  });
  const client = new AguiRunClient({ url: '/agui', agentId: 'a', threadId: 's', fetch, onEvent: event => events.push(event) });
  const first = await client.run('first question', 'r');
  expect(events.filter(event => event.type === 'text_replace')).toEqual([{ type: 'text_replace', messageId: 'm', text: content, sessionId: 's' }]);
  expect(first.result.newMessages).toContainEqual(expect.objectContaining({ id: 'm', content: content + '!', toolCalls: [expect.objectContaining({ id: 'lookup' })] }));
  expect(first.result.newMessages).toContainEqual(expect.objectContaining({ id: 'lookup-result', role: 'tool', content: 'kept' }));
  expect(first.result.newMessages).toContainEqual(expect.objectContaining({ id: 'card', role: 'activity' }));
  await client.run('next question', 'next');
  expect(bodies[1].messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'r:user', role: 'user', content: 'first question' }),
    expect.objectContaining({ id: 'm', role: 'assistant', content: content + '!', toolCalls: [expect.objectContaining({ id: 'lookup' })] }),
    expect.objectContaining({ id: 'lookup-result', role: 'tool', content: 'kept' }),
  ]));
});

it('rejects malformed, cross-thread, old-run and unowned message snapshots through the real protocol', async () => {
  const events: RunEvent[] = [];
  const client = new AguiRunClient({ url: '/agui', agentId: 'a', threadId: 's', onEvent: event => events.push(event),
    fetch: vi.fn(async () => sse([start(), { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'original' },
      snapshot('bad', { threadId: 'other' }), snapshot('bad', { runId: 'old' }), snapshot('bad', { messageId: 'history' }),
      snapshot('bad', { version: 2 }), snapshot('bad', { content: null }),
      { type: 'TEXT_MESSAGE_END', messageId: 'm' }, end(),
    ])) });
  const result = await client.run('ask', 'r');
  expect(events.filter(event => event.type === 'text_replace')).toEqual([]);
  expect(result.result.newMessages).toContainEqual(expect.objectContaining({ id: 'm', content: 'original' }));
});

it('ignores late callbacks from a superseded execute and after abort', async () => {
  // Public transport callback fixture: exercise stale delivery beyond the HTTP client's own cancellation fence.
  const subscribers: AgentSubscriber[] = [];
  vi.spyOn(HttpAgent.prototype, 'runAgent').mockImplementation(async (_params, subscriber) => {
    subscribers.push(subscriber!); return { result: null, newMessages: [] };
  });
  const projected: RunEvent[] = [];
  const client = new AguiRunClient({ url: '/agui', agentId: 'a', threadId: 's', onEvent: event => projected.push(event) });
  const params = (event: Record<string, unknown>) => ({ event, messages: [{ id: 'm', role: 'assistant', content: 'old' }], state: {}, input: {}, agent: {} }) as never;
  await client.run('first', 'r');
  await subscribers[0].onEvent?.(params({ type: 'TEXT_MESSAGE_START', messageId: 'm' }));
  expect(await subscribers[0].onCustomEvent?.(params(snapshot('after-finish')))).toBeUndefined();
  await client.run('second', 'second');
  await subscribers[0].onEvent?.(params(snapshot('late')));
  expect(await subscribers[0].onCustomEvent?.(params(snapshot('late')))).toBeUndefined();
  await subscribers[1].onEvent?.(params({ type: 'TEXT_MESSAGE_START', messageId: 'm' }));
  client.abort();
  await subscribers[1].onEvent?.(params(snapshot('late', { runId: 'second' })));
  expect(await subscribers[1].onCustomEvent?.(params(snapshot('late', { runId: 'second' })))).toBeUndefined();
  expect(projected.filter(event => event.type === 'text_replace')).toEqual([]);
});

describe('per-message text replacement', () => {
  beforeEach(() => useSessionStore.getState().setCurrentSessionId('s'));
  const blocks: ProcessingBlock[] = [
    { id: 'first', type: 'text', content: 'prefix OLD', status: 'done' },
    { id: 'tool', type: 'tool', toolName: 'lookup', args: '{}', status: 'completed' },
    { id: 'middle', type: 'text', content: ' DRAFT', status: 'done' },
    { id: 'thinking', type: 'thinking', content: 'not an answer', status: 'done' },
    { id: 'last', type: 'text', content: ' suffix', status: 'streaming' },
  ];
  it.each(['prefix NEW suffix', 'prefix OLD DRAFT suffix!', 'prefix ', '', '😀 replacement'])('replaces all affected text and preserves non-text blocks: %j', text => {
    const next = replaceTextBlocks(blocks, text);
    expect(next.filter(block => block.type === 'text').map(block => block.content).join('')).toBe(text);
    expect(next.filter(block => block.type !== 'text')).toEqual([blocks[1], blocks[3]]);
    expect(next[1]).toBe(blocks[1]); expect(next[3]).toBe(blocks[3]);
    expect(appendTextBlock(next, '!').filter(block => block.type === 'text').map(block => block.content).join('')).toBe(text + '!');
    expect(replaceTextBlocks(next, text)).toBe(next);
  });
  it('keeps tool/thinking positions and unaffected text around the minimal edit range', () => {
    const next = replaceTextBlocks(blocks, 'prefix NEW DRAFT suffix');
    expect(next.map(block => block.id)).toEqual(blocks.map(block => block.id));
    expect(next[2]).toBe(blocks[2]); expect(next[4]).toBe(blocks[4]);
  });
  it('updates only the target body, preserving its cards/tools/reasoning and other messages', () => {
    const target = { id: 'm', role: 'model' as const, content: 'prefix OLD DRAFT suffix', timestamp: 1, blocks,
      reasoning: 'private legacy reasoning stays', tools: { lookup: { name: 'lookup', args: '{}', status: 'completed' as const } },
      aguiActivities: [{ surfaceId: 'card', messages: [] }] };
    const history = { id: 'history', role: 'model' as const, content: 'history', timestamp: 0 };
    useMessageStore.getState().setMessages([history, target]);
    dispatchRunEventToStores({ type: 'text_replace', sessionId: 's', messageId: 'm', text: '' });
    const [retained, edited] = useMessageStore.getState().messages;
    expect(retained).toBe(history); expect(edited.content).toBe(''); expect(edited.reasoning).toBe(target.reasoning);
    expect(edited.tools).toBe(target.tools); expect(edited.aguiActivities).toBe(target.aguiActivities);
    const before = useMessageStore.getState().messages;
    dispatchRunEventToStores({ type: 'text_replace', sessionId: 'elsewhere', messageId: 'm', text: 'wrong' }, { visible: true });
    dispatchRunEventToStores({ type: 'text_replace', sessionId: 's', messageId: 'm', text: 'offscreen' }, { visible: false });
    dispatchRunEventToStores({ type: 'text_replace', sessionId: 's', messageId: 'unknown', text: 'unknown' });
    expect(useMessageStore.getState().messages).toEqual(before);
  });
});
