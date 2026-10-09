import { describe, expect, it } from 'vitest';
import { rebuildPersistedSessionHistory } from '../utils/persisted-session-history.js';
import type { Message } from '../components/chat/types.js';
import type { PersistedSessionEventRecord } from '../utils/persisted-session-history.js';
import { mapBackendMessages } from '../utils/messages.js';
import legacyFailedHistory from './fixtures/legacy-failed-session-history.json';
import { readFileSync } from 'node:fs';

describe('legacy terminal receipts observed in control fallback history', () => {
  const records = legacyFailedHistory.Events as unknown as PersistedSessionEventRecord[];
  const fallback = () => mapBackendMessages(legacyFailedHistory.Messages) as Message[];
  const rebuild = (messages = fallback(), events = records) => rebuildPersistedSessionHistory(
    messages, events, legacyFailedHistory.SessionId, 'agent-block-v1',
  );

  it('retains the complete observed transcript and tool identities while presenting the failed receipt', () => {
    const original = fallback();
    const inputSnapshot = JSON.stringify(original);
    const output = rebuild(original);
    const assistant = output.messages.find(message => message.role === 'model')!;
    const originalAssistant = original.find(message => message.role === 'model')!;
    const receipt = output.messages.find(message => message.role === 'system')!;
    expect(records).toHaveLength(18);
    expect(new Set(records.map(event => event.EventId)).size).toBe(18);
    expect(output.messages).toHaveLength(3);
    expect(receipt).toMatchObject({
      id: records.at(-1)!.EventId, eventId: records.at(-1)!.EventId,
      invocationId: originalAssistant.invocationId, eventType: 'run_status', status: 'failed',
      content: '本轮运行失败。', timestamp: Date.parse(String(records.at(-1)!.Timestamp)),
    });
    expect(output.messages[0]).toEqual(original[0]);
    expect(assistant.reasoning).toBe(originalAssistant.reasoning);
    expect(assistant.reasoning).toHaveLength(2287);
    expect(assistant.content).toBe(originalAssistant.content);
    expect(assistant.blocks?.filter(block => block.type === 'thinking')).toHaveLength(1);
    expect(assistant.blocks?.filter(block => block.type === 'tool')).toHaveLength(8);
    expect(Object.keys(assistant.tools!)).toEqual(Object.keys(originalAssistant.tools!));
    Object.entries(assistant.tools!).forEach(([key, tool]) => {
      const before = originalAssistant.tools![key];
      expect(tool).toMatchObject({ name: before.name, args: before.args });
      expect(tool.previousResponseId).toBe(before.previousResponseId);
      if (before.status === 'completed') expect(tool).toEqual(before);
      else if (before.status === 'running') expect(tool.status).toBe('unknown');
    });
    expect(Object.values(assistant.tools!).filter(tool => tool.name === 'commandExecution').map(tool => tool.status))
      .toEqual(['completed', 'completed']);
    expect(Object.values(assistant.tools!).filter(tool => tool.name === 'dynamicToolCall')).toHaveLength(1);
    expect(assistant.blocks?.filter(block => block.type === 'tool' && block.status === 'unknown')
      .map(block => block.type === 'tool' && block.extra?.persistedToolStatus)).toEqual(Array(5).fill('running'));
    expect(JSON.stringify(original)).toBe(inputSnapshot);
    expect(output.canonicalRunIds).toEqual([]);
    expect(output.translatedEvents).toEqual([]);
    expect(rebuild(output.messages).messages).toEqual(output.messages);
  });

  it('adds a receipt from a newest-only page without changing a different active run', () => {
    const active: Message = {
      id: 'other-model', role: 'model', invocationId: 'other-run', content: 'An independent run.', timestamp: 1_800_000_000_000,
      tools: { independent: { name: 'independent', args: '{}', status: 'running' } },
    };
    const output = rebuild([...fallback(), active], [records.at(-1)!]);
    expect(output.messages.find(message => message.id === active.id)).toEqual(active);
    expect(output.messages.filter(message => message.status === 'failed')).toHaveLength(1);
  });

  it('honours the last status and does not fabricate successful tool results from completed roots', () => {
    for (const status of ['in_progress', 'completed']) {
      const latest = { ...records.at(-1)!, SeqId: 586, Content: { status } };
      const original = fallback();
      expect(rebuild(original, [...records, latest]).messages).toEqual(original);
    }
  });

  it('presents cancellation as cancellation with pending results unknown', () => {
    const cancelled = { ...records.at(-1)!, Content: { status: 'cancelled' } };
    const output = rebuild(fallback(), [cancelled]);
    expect(output.messages.find(message => message.role === 'system')?.status).toBe('cancelled');
    expect(Object.values(output.messages.find(message => message.role === 'model')!.tools!)
      .filter(tool => tool.name === 'dynamicToolCall')[0].status).toBe('unknown');
  });

  it('supplements partial canonical history when its terminal boundary is missing', () => {
    const canonical: PersistedSessionEventRecord = {
      ...records.at(-1)!, EventId: 'canonical-start', SeqId: 587, EventType: 'runtime.run.started',
      Content: { runtime_event: { event_type: 'run.started', run_id: records.at(-1)!.InvocationId } },
    };
    const original = fallback();
    const output = rebuild(original, [...records, canonical]);
    expect(output.messages.find(message => message.role === 'system')?.status).toBe('failed');
    expect(output.messages.find(message => message.role === 'model')?.reasoning).toBe(original[1].reasoning);
    expect(Object.values(output.messages.find(message => message.role === 'model')!.tools!)
      .filter(tool => tool.name === 'commandExecution').map(tool => tool.status)).toEqual(['completed', 'completed']);
    expect(output.canonicalRunIds).toEqual([]);
  });

  it('does not override an actual canonical root terminal with a legacy mirror', () => {
    const canonical: PersistedSessionEventRecord = {
      ...records.at(-1)!, EventId: 'canonical-answer', SeqId: 1, EventType: 'runtime.item.completed',
      Content: { runtime_event: {
        event_type: 'item.completed', run_id: records.at(-1)!.InvocationId,
        scope_id: records.at(-1)!.InvocationId, item_id: 'canonical-answer', item_kind: 'message',
        snapshot: { parts: [{ part_id: 'answer-text', text: 'Canonical reply.' }] },
        source: { metadata: { native_item_kind: 'agentMessage' } },
      } },
    };
    const original = fallback();
    for (const eventType of ['run.completed', 'run.failed']) {
      const terminal: PersistedSessionEventRecord = {
        ...canonical, EventId: 'root-terminal', SeqId: 586,
        Content: { runtime_event: { event_type: eventType, run_id: records.at(-1)!.InvocationId } },
      };
      const withoutMirror = rebuild(original, [canonical, terminal]);
      const withMirror = rebuild(original, [canonical, ...records, terminal]);
      const comparable = (messages: Message[]) => messages.map(message => ({
        ...message, blocks: message.blocks?.map(block => ({ ...block, id: undefined })),
      }));
      expect(comparable(withMirror.messages)).toEqual(comparable(withoutMirror.messages));
      expect(withMirror.canonicalRunIds).toEqual(withoutMirror.canonicalRunIds);
      expect(withMirror.messages.some(message => message.id === records.at(-1)!.EventId)).toBe(false);
    }
  });

  it('keeps the compatibility failure visible after strict replay of a still-open remote run', () => {
    const frames = readFileSync(new URL('./fixtures/a2a_remote_agent/v1/a2a_stream_tool_terminal.jsonl', import.meta.url), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line)).filter(row => row.kind === 'runtime_event').map(row => row.payload)
      .filter(frame => !['run.completed', 'run.failed'].includes(frame.event_type));
    const canonical = frames.map((frame, index) => ({
      EventId: frame.event_id, SeqId: index + 1, EventType: 'runtime_event', Content: { runtime_event: frame },
    }));
    const legacy = { ...records.at(-1)!, InvocationId: 'root-run-1', Metadata: { run_id: 'root-run-1' } };
    const output = rebuild([], [...canonical, legacy]);
    expect(output.canonicalRunIds).toContain('root-run-1');
    expect(output.messages.some(message => message.agentBlock)).toBe(true);
    expect(output.messages.find(message => message.id === legacy.EventId)).toMatchObject({ status: 'failed', invocationId: 'root-run-1' });
  });
});

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
        // Local Studio persists the additive canonical payload in camelCase;
        // cloud/session-envelope history may still use runtime_event.
        runtimeEvent: {
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
        runtimeEvent: {
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
      callId: 'call-mcp-tool',
      status: 'error',
    });
    expect(tool?.output).toContain('user rejected MCP tool call');
    expect(rebuilt.messages.find(
      (message) => message.tools?.['mcp.metaso-inner.metaso_topic_list'],
    )?.blocks).toContainEqual(expect.objectContaining({
      type: 'tool',
      extra: { callId: 'call-mcp-tool' },
    }));
  });

  it('drops the failed assistant projection after custom feedback cancels an approval run', () => {
    const fallback: Message[] = [
      {
        id: 'user-cancelled-run',
        role: 'user',
        content: '执行原命令',
        timestamp: 1_700_000_000_000,
        invocationId: 'run-cancelled-by-feedback',
      },
      {
        id: 'assistant-cancelled-run',
        role: 'model',
        content: 'Codex turn/interrupt completed',
        timestamp: 1_700_000_001_000,
        invocationId: 'run-cancelled-by-feedback',
      },
    ];
    const records: PersistedSessionEventRecord[] = [{
      SeqId: 43,
      EventId: 'approval-resolution',
      EventType: 'approval.resolved',
      InvocationId: 'run-cancelled-by-feedback',
      Timestamp: '1700000001',
      Content: {
        name: 'cancel',
        data: { feedback: '请改成 echo 你好' },
        revision: 2,
      },
    } as PersistedSessionEventRecord];

    const rebuilt = rebuildPersistedSessionHistory(fallback, records, 'session-feedback');

    expect(rebuilt.messages.map((message) => message.content)).toEqual(['执行原命令']);
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

  it('coalesces an identity-less tool start with the terminal call identity', () => {
    const fallback: Message[] = [
      {
        id: 'user-late-tool-identity',
        role: 'user',
        content: '查询答案',
        timestamp: 1_700_000_000_000,
        invocationId: 'run-late-tool-identity',
      },
      {
        id: 'assistant-late-tool-identity',
        role: 'model',
        content: '答案是 42。',
        timestamp: 1_700_000_004_000,
        invocationId: 'run-late-tool-identity',
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
      InvocationId: 'run-late-tool-identity',
      Timestamp: String(1_700_000_000 + seq),
      Content: {
        runtime_event: {
          schema_version: 2,
          family: 'runtime',
          run_id: 'run-late-tool-identity',
          scope_id: 'scope-late-tool-identity',
          event_id: eventId,
          seq,
          source: { framework: 'adk', metadata: {} },
          ...runtimeEvent,
        },
      },
    });
    const records = [
      runtimeRecord(1, 'run-started', { event_type: 'run.started' }),
      runtimeRecord(2, 'tool-started', {
        event_type: 'item.started',
        item_id: 'runtime-tool-item',
        item_kind: 'tool_call',
        initial: { parts: [] },
      }),
      runtimeRecord(3, 'tool-completed', {
        event_type: 'item.completed',
        item_id: 'runtime-tool-item',
        item_kind: 'tool_call',
        snapshot: {
          parts: [{
            content_type: 'tool_call',
            part_id: 'tool-call',
            call_id: 'lookup-1',
            name: 'lookup',
            arguments: { question: 'life' },
          }, {
            content_type: 'tool_result',
            part_id: 'tool-result',
            call_id: 'lookup-1',
            result: 42,
          }],
        },
      }),
      runtimeRecord(4, 'assistant-completed', {
        event_type: 'item.completed',
        item_id: 'assistant-item',
        item_kind: 'message',
        snapshot: {
          parts: [{ content_type: 'text', part_id: 'text', text: '答案是 42。' }],
        },
      }),
      runtimeRecord(5, 'run-completed', { event_type: 'run.completed' }),
    ];

    const rebuilt = rebuildPersistedSessionHistory(fallback, records, 'session-late-tool');
    const tools = rebuilt.messages.flatMap((message) => Object.values(message.tools || {}));

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: 'lookup',
      callId: 'lookup-1',
      status: 'completed',
    });
    expect(tools[0]?.output).toBe('42');
    expect(tools.some((tool) => tool.name === 'tool' && tool.status === 'running')).toBe(false);
  });
});
