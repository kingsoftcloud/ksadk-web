import { describe, expect, it } from 'vitest';
import type { Message } from '../components/chat/types.js';
import { mergeRecoveredRunMessages } from '../utils/recovered-run.js';

describe('mergeRecoveredRunMessages', () => {
  it('replaces a partial history row using the stable invocation id', () => {
    const history: Message[] = [{
      id: 'snapshot-1',
      role: 'model',
      content: '这是一段已经',
      timestamp: 1,
      invocationId: 'inv-1',
    }];

    const merged = mergeRecoveredRunMessages(history, [{
      EventId: 'snapshot-2',
      EventType: 'assistant_stream_snapshot',
      InvocationId: 'inv-1',
      SeqId: 2,
      Content: { role: 'assistant', parts: [{ text: '这是一段已经恢复的完整回复。' }] },
      Timestamp: 2,
    }], 'inv-1');

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: 'snapshot-1',
      invocationId: 'inv-1',
      content: '这是一段已经恢复的完整回复。',
    });
  });

  it('keeps distinct runtime message items and replaces completed reasoning snapshots', () => {
    const runtimeItem = (
      itemId: string,
      operation: 'append' | 'replace' | 'completed',
      partId = 'text-0',
    ) => ({
      RuntimeItem: {
        RunId: 'run-1',
        ScopeId: 'scope-1',
        ItemId: itemId,
        PartId: partId,
        Operation: operation,
      },
    });
    const events = [
      {
        EventId: 'reason-delta',
        EventType: 'reasoning',
        InvocationId: 'run-1',
        Content: { parts: [{ text: '先分析' }] },
        Metadata: runtimeItem('reason-1', 'append', 'reason-0'),
      },
      {
        EventId: 'reason-completed',
        EventType: 'reasoning',
        InvocationId: 'run-1',
        Content: { parts: [{ text: '先分析，再核对' }] },
        Metadata: runtimeItem('reason-1', 'completed', 'reason-0'),
      },
      {
        EventId: 'commentary-completed',
        EventType: 'assistant_message',
        InvocationId: 'run-1',
        Content: { parts: [{ text: '我先检查目录。' }] },
        Metadata: runtimeItem('message-1', 'completed'),
      },
      {
        EventId: 'answer-completed',
        EventType: 'assistant_message',
        InvocationId: 'run-1',
        Content: { parts: [{ text: '最终答案。' }] },
        Metadata: runtimeItem('message-2', 'completed'),
      },
    ];

    const merged = mergeRecoveredRunMessages([], events, 'run-1');

    expect(merged).toHaveLength(2);
    expect(merged.map((message) => message.itemId)).toEqual(['message-1', 'message-2']);
    expect(merged[0]).toMatchObject({
      content: '我先检查目录。',
      reasoning: '先分析，再核对',
    });
    expect(merged[1]).toMatchObject({ content: '最终答案。' });
  });

  it('streams a later runtime item after an earlier item in the same run completed', () => {
    const metadata = (itemId: string, operation: 'replace' | 'completed') => ({
      RuntimeItem: {
        RunId: 'run-1',
        ScopeId: 'scope-1',
        ItemId: itemId,
        PartId: 'text-0',
        Operation: operation,
      },
    });
    const merged = mergeRecoveredRunMessages([], [
      {
        EventId: 'commentary-completed',
        EventType: 'assistant_message',
        InvocationId: 'run-1',
        Content: { parts: [{ text: '正在检查。' }] },
        Metadata: metadata('message-1', 'completed'),
      },
      {
        EventId: 'answer-snapshot',
        EventType: 'assistant_stream_snapshot',
        InvocationId: 'run-1',
        Content: { parts: [{ text: '最终答案的前半段' }] },
        Metadata: metadata('message-2', 'replace'),
      },
    ], 'run-1');

    expect(merged.map((message) => message.content)).toEqual([
      '正在检查。',
      '最终答案的前半段',
    ]);
  });

  it('keeps repeated tool names as distinct runtime items across replay', () => {
    const metadata = (itemId: string, operation: 'replace' | 'completed') => ({
      call_id: itemId,
      tool_name: 'search',
      RuntimeItem: {
        RunId: 'run-1',
        ScopeId: 'scope-1',
        ItemId: itemId,
        Operation: operation,
      },
    });
    const events = [
      {
        EventId: 'tool-1-start',
        EventType: 'tool_call',
        InvocationId: 'run-1',
        Metadata: { ...metadata('tool-1', 'replace'), tool_args: { q: 'first' } },
      },
      {
        EventId: 'tool-1-done',
        EventType: 'tool_result',
        InvocationId: 'run-1',
        Metadata: { ...metadata('tool-1', 'completed'), tool_output: { value: 'one' } },
      },
      {
        EventId: 'tool-2-start',
        EventType: 'tool_call',
        InvocationId: 'run-1',
        Metadata: { ...metadata('tool-2', 'replace'), tool_args: { q: 'second' } },
      },
      {
        EventId: 'tool-2-done',
        EventType: 'tool_result',
        InvocationId: 'run-1',
        Metadata: { ...metadata('tool-2', 'completed'), tool_output: { value: 'two' } },
      },
    ];

    const merged = mergeRecoveredRunMessages([], events, 'run-1');

    expect(merged.map((message) => message.itemId)).toEqual(['tool-1', 'tool-2']);
    expect(merged.map((message) => message.tools?.search?.output)).toEqual([
      '{\n  "value": "one"\n}',
      '{\n  "value": "two"\n}',
    ]);
  });

  it('keeps consecutive reasoning items separate by RuntimeItem identity', () => {
    const events = ['reason-1', 'reason-2'].map((itemId, index) => ({
      EventId: `${itemId}-done`,
      EventType: 'reasoning',
      InvocationId: 'run-1',
      Content: { parts: [{ text: index === 0 ? '第一段推理' : '第二段推理' }] },
      Metadata: {
        RuntimeItem: {
          RunId: 'run-1',
          ScopeId: 'scope-1',
          ItemId: itemId,
          PartId: 'reason-0',
          Operation: 'completed',
        },
      },
    }));

    const merged = mergeRecoveredRunMessages([], events, 'run-1');

    expect(merged.map((message) => message.itemId)).toEqual(['reason-1', 'reason-2']);
    expect(merged.map((message) => message.reasoning)).toEqual(['第一段推理', '第二段推理']);
  });
});
