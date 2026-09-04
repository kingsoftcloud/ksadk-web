import { describe, expect, it } from 'vitest';
import { rebuildPersistedSessionHistory } from '../utils/persisted-session-history.js';
import type { Message } from '../components/chat/types.js';
import type { PersistedSessionEventRecord } from '../utils/persisted-session-history.js';

describe('rebuildPersistedSessionHistory', () => {
  it('normalises RuntimeEvent Unix seconds before ordering with millisecond message rows', () => {
    const fallback: Message[] = [{
      id: 'user-1',
      role: 'user',
      content: '先提问',
      timestamp: 1_700_000_000_000,
    }];
    const events: PersistedSessionEventRecord[] = [{
      SeqId: 1,
      EventId: 'event-1',
      EventType: 'runtime.item.completed',
      InvocationId: 'run-1',
      // Production RuntimeEvent/v2 persists this value in Unix seconds.
      Timestamp: '1700000001',
      Content: {
        runtime_event: {
          family: 'runtime',
          event_type: 'item.completed',
          event_id: 'event-1',
          run_id: 'run-1',
          scope_id: 'run-1',
          item_id: 'assistant-1',
          item_kind: 'message',
          snapshot: { parts: [{ part_id: 'text-1', text: '再回答' }] },
          source: { metadata: { native_item_kind: 'agentMessage' } },
        },
      },
    }];

    const rebuilt = rebuildPersistedSessionHistory(fallback, events, 'session-1');

    expect(rebuilt.messages.map((message) => message.content)).toEqual(['先提问', '再回答']);
    expect(rebuilt.messages[1]?.timestamp).toBe(1_700_000_001_000);
  });

  it('keeps the compatibility projection when canonical history contains only a user item', () => {
    const fallback: Message[] = [
      {
        id: 'user-fallback',
        role: 'user',
        content: '继续上文',
        timestamp: 1_700_000_000_000,
        invocationId: 'run-incomplete',
      },
      {
        id: 'assistant-fallback',
        role: 'model',
        content: '这是仍可从兼容投影读取的回复。',
        timestamp: 1_700_000_001_000,
        invocationId: 'run-incomplete',
      },
    ];
    const events: PersistedSessionEventRecord[] = [{
      SeqId: 1,
      EventId: 'event-user-only',
      EventType: 'runtime.item.completed',
      InvocationId: 'run-incomplete',
      Timestamp: 1_700_000_000 as unknown as string,
      Content: {
        runtime_event: {
          family: 'runtime',
          event_type: 'item.completed',
          event_id: 'event-user-only',
          run_id: 'run-incomplete',
          scope_id: 'run-incomplete',
          item_id: 'user-item',
          item_kind: 'message',
          snapshot: {
            parts: [{
              part_id: 'user-part',
              content_type: 'data',
              data: {
                type: 'userMessage',
                content: [{ type: 'text', text: '继续上文' }],
              },
            }],
          },
          source: { metadata: { native_item_kind: 'userMessage' } },
        },
      },
    }];

    const rebuilt = rebuildPersistedSessionHistory(fallback, events, 'session-1');

    expect(rebuilt.messages.map((message) => message.content)).toEqual([
      '继续上文',
      '这是仍可从兼容投影读取的回复。',
    ]);
    expect(rebuilt.canonicalRunIds).toEqual([]);
  });

  it('keeps the complete message projection when a newest-event page starts mid-run', () => {
    const fallback: Message[] = [
      {
        id: 'user-fallback',
        role: 'user',
        content: '检查运行状态',
        timestamp: 1_700_000_000_000,
        invocationId: 'run-partial-page',
      },
      {
        id: 'assistant-fallback',
        role: 'model',
        content: '运行已经结束。',
        timestamp: 1_700_000_001_000,
        invocationId: 'run-partial-page',
        tools: {
          inspect_status: {
            name: 'inspect_status',
            args: '{}',
            output: '{"status":"completed"}',
            status: 'completed',
          },
        },
      },
    ];
    const events: PersistedSessionEventRecord[] = [{
      SeqId: 900,
      EventId: 'event-terminal-only',
      EventType: 'runtime.item.completed',
      InvocationId: 'run-partial-page',
      Timestamp: '1700000001',
      Content: {
        runtime_event: {
          family: 'runtime',
          event_type: 'item.completed',
          event_id: 'event-terminal-only',
          run_id: 'run-partial-page',
          scope_id: 'run-partial-page',
          item_id: 'assistant-item',
          item_kind: 'message',
          snapshot: { parts: [{ part_id: 'text-1', text: '运行已经结束。' }] },
          source: { metadata: { native_item_kind: 'agentMessage' } },
        },
      },
    }];

    const rebuilt = rebuildPersistedSessionHistory(fallback, events, 'session-1');

    expect(rebuilt.canonicalRunIds).toEqual([]);
    expect(rebuilt.messages.find((message) => message.tools?.inspect_status)?.tools?.inspect_status.status)
      .toBe('completed');
  });

  it('adds tool facts from an older event page without replacing a partial run transcript', () => {
    const fallback: Message[] = [
      {
        id: 'user-partial-tools',
        role: 'user',
        content: '查一下最新新闻',
        timestamp: 1_700_000_000_000,
        invocationId: 'run-partial-tools',
      },
      {
        id: 'assistant-partial-tools',
        role: 'model',
        content: '搜索工具被拒绝了。',
        timestamp: 1_700_000_004_000,
        invocationId: 'run-partial-tools',
      },
    ];
    const runtimeRecord = (
      seq: number,
      eventId: string,
      runtimeEvent: Record<string, unknown>,
    ): PersistedSessionEventRecord => ({
      SeqId: seq,
      EventId: eventId,
      EventType: String(runtimeEvent.event_type || ''),
      InvocationId: 'run-partial-tools',
      Timestamp: String(1_700_000_000 + seq),
      Content: {
        runtime_event: {
          family: 'runtime',
          run_id: 'run-partial-tools',
          scope_id: 'scope-partial-tools',
          event_id: eventId,
          seq,
          source: { framework: 'codex', metadata: { native_item_kind: 'mcpToolCall' } },
          ...runtimeEvent,
        },
      },
    });
    const records = [
      runtimeRecord(945, 'mcp-started', {
        event_type: 'item.started',
        item_id: 'item-mcp-tool',
        item_kind: 'tool_call',
        initial: {
          parts: [{
            content_type: 'tool_call',
            part_id: 'tool-call',
            call_id: 'call-mcp-tool',
            name: 'mcp.metaso-inner.metaso_topic_list',
            arguments: {},
          }],
        },
      }),
      runtimeRecord(946, 'mcp-updated', {
        event_type: 'item.updated',
        item_id: 'item-mcp-tool',
        item_kind: 'tool_call',
        op: 'replace',
        update: {
          content_type: 'tool_result',
          part_id: 'tool-result',
          call_id: 'call-mcp-tool',
          result: { status: 'failed', error: { message: 'user rejected MCP tool call' } },
          is_error: true,
        },
      }),
      runtimeRecord(947, 'mcp-failed', {
        event_type: 'item.failed',
        item_id: 'item-mcp-tool',
        item_kind: 'tool_call',
        error: { code: 'codex_mcp_tool_failed', message: 'Codex mcpToolCall failed' },
      }),
    ];

    const rebuilt = rebuildPersistedSessionHistory(fallback, records, 'session-tools');

    expect(rebuilt.canonicalRunIds).toEqual([]);
    expect(rebuilt.messages.map((message) => message.content)).toEqual([
      '查一下最新新闻',
      '搜索工具被拒绝了。',
    ]);
    const tool = rebuilt.messages.find(
      (message) => message.tools?.['mcp.metaso-inner.metaso_topic_list'],
    )?.tools?.['mcp.metaso-inner.metaso_topic_list'];
    expect(tool).toMatchObject({
      name: 'mcp.metaso-inner.metaso_topic_list',
      status: 'error',
    });
    expect(tool?.output).toContain('user rejected MCP tool call');
  });

  it('rehydrates LangGraph tool calls from canonical history after refresh', () => {
    const fallback: Message[] = [
      {
        id: 'user-fallback',
        role: 'user',
        content: '你有哪些记忆',
        timestamp: 1_700_000_000_000,
        invocationId: 'run-tools',
      },
      {
        id: 'assistant-fallback',
        role: 'model',
        content: '找到一条记忆。',
        timestamp: 1_700_000_004_000,
        invocationId: 'run-tools',
      },
    ];
    const runtimeRecord = (
      seq: number,
      eventId: string,
      runtimeEvent: Record<string, unknown>,
    ): PersistedSessionEventRecord => ({
      SeqId: seq,
      EventId: eventId,
      EventType: String(runtimeEvent.event_type || ''),
      InvocationId: 'run-tools',
      Timestamp: (1_700_000_000 + seq) as unknown as string,
      Content: {
        runtime_event: {
          family: 'runtime',
          run_id: 'run-tools',
          scope_id: 'scope-tools',
          event_id: eventId,
          seq,
          source: { framework: 'langgraph', metadata: {} },
          ...runtimeEvent,
        },
      },
    });
    const records: PersistedSessionEventRecord[] = [
      runtimeRecord(1, 'tool-started', {
        event_type: 'item.started',
        item_id: 'tool-call-item',
        item_kind: 'tool_call',
        initial: {
          parts: [{
            content_type: 'tool_call',
            part_id: 'tool_call',
            call_id: 'call-memory',
            name: 'load_memory',
            arguments: { query: '*' },
          }],
        },
      }),
      runtimeRecord(2, 'tool-call-completed', {
        event_type: 'item.completed',
        item_id: 'tool-call-item',
        item_kind: 'tool_call',
        snapshot: {
          parts: [{
            content_type: 'tool_call',
            part_id: 'tool_call',
            call_id: 'call-memory',
            name: 'load_memory',
            arguments: { query: '*' },
          }],
        },
      }),
      runtimeRecord(3, 'tool-result-completed', {
        event_type: 'item.completed',
        item_id: 'tool-result-item',
        item_kind: 'tool_result',
        snapshot: {
          parts: [{
            content_type: 'tool_result',
            part_id: 'tool_result',
            call_id: 'call-memory',
            result: { value: '武汉热干面' },
          }],
        },
      }),
      runtimeRecord(4, 'assistant-completed', {
        event_type: 'item.completed',
        item_id: 'assistant-item',
        item_kind: 'message',
        snapshot: {
          parts: [{ content_type: 'text', part_id: 'text-0', text: '找到一条记忆。' }],
        },
      }),
    ];

    const rebuilt = rebuildPersistedSessionHistory(fallback, records, 'session-tools');

    expect(rebuilt.messages.some((message) => (
      message.role === 'user' && message.content === '你有哪些记忆'
    ))).toBe(true);
    const toolMessage = rebuilt.messages.find((message) => message.tools?.load_memory);
    expect(toolMessage?.tools?.load_memory).toMatchObject({
      name: 'load_memory',
      args: '{\n  "query": "*"\n}',
      output: '{\n  "value": "武汉热干面"\n}',
      status: 'completed',
    });
    expect(rebuilt.messages.some((message) => message.content === '找到一条记忆。')).toBe(true);
  });
});
