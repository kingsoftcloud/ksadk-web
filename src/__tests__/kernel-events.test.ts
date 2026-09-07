import { describe, expect, it } from 'vitest';

import { KernelRunEventTranslator, peekKernelReceipt } from '../core/stream/kernel-events.js';

function itemFrame(
  seq: number,
  eventType: string,
  nativeKind: string,
  extra: Record<string, unknown> = {},
) {
  return {
    seq,
    family: 'runtime',
    family_version: 2,
    event_type: eventType,
    run_id: 'run-1',
    item_id: `item-${seq}`,
    event_id: `event-${seq}`,
    item_kind: nativeKind === 'reasoning' ? 'reasoning' : 'message',
    source: { metadata: { native_item_kind: nativeKind } },
    ...extra,
  };
}

const USER_SNAPSHOT = {
  snapshot: {
    parts: [
      {
        part_id: 'p1',
        content_type: 'data',
        data: { type: 'userMessage', content: [{ type: 'text', text: '你好' }] },
      },
    ],
  },
};

const AGENT_SNAPSHOT = (text: string) => ({
  snapshot: { parts: [{ part_id: 'p2', content_type: 'text', text }] },
});

describe('KernelRunEventTranslator', () => {
  it('projects userMessage completion to a user_message record', () => {
    const t = new KernelRunEventTranslator('sess-1');
    const record = t.translate(itemFrame(9, 'item.completed', 'userMessage', USER_SNAPSHOT));
    expect(record?.EventType).toBe('user_message');
    expect(record?.Content).toEqual({ parts: [{ text: '你好' }] });
    expect(record?.SeqId).toBe(9);
  });

  it('projects agentMessage completion to an assistant_message record', () => {
    const t = new KernelRunEventTranslator('sess-1');
    const record = t.translate(
      itemFrame(10, 'item.completed', 'agentMessage', AGENT_SNAPSHOT('回复内容')),
    );
    expect(record?.EventType).toBe('assistant_message');
    expect(record?.Content).toEqual({ parts: [{ text: '回复内容' }] });
  });

  it('accumulates item.updated append deltas into cumulative snapshots', () => {
    const t = new KernelRunEventTranslator('sess-1');
    const first = t.translate(
      itemFrame(11, 'item.updated', 'agentMessage', {
        item_id: 'message-1',
        op: 'replace',
        update: { part_id: 'p2', content_type: 'text', text: '你好' },
      }),
    );
    const second = t.translate(
      itemFrame(12, 'item.updated', 'agentMessage', {
        item_id: 'message-1',
        op: 'append',
        update: { part_id: 'p2', content_type: 'text', text: '，世界' },
      }),
    );
    expect(first?.Content).toEqual({ parts: [{ text: '你好' }] });
    expect(second?.Content).toEqual({ parts: [{ text: '你好，世界' }] });
  });

  it('reads item.updated from the RuntimeEvent/v2 update field', () => {
    const t = new KernelRunEventTranslator('sess-1');
    const first = t.translate(itemFrame(15, 'item.updated', 'agentMessage', {
      item_id: 'message-1',
      op: 'append',
      update: { part_id: 'p2', content_type: 'text', text: '云端' },
    }));
    const second = t.translate(itemFrame(16, 'item.updated', 'agentMessage', {
      item_id: 'message-1',
      op: 'append',
      update: { part_id: 'p2', content_type: 'text', text: '流式' },
    }));

    expect(first?.Content).toEqual({ parts: [{ text: '云端' }] });
    expect(second?.Content).toEqual({ parts: [{ text: '云端流式' }] });
  });

  it('atomically replaces an open assistant item snapshot', () => {
    const t = new KernelRunEventTranslator('sess-1');
    t.translate(itemFrame(17, 'item.updated', 'agentMessage', {
      item_id: 'message-1',
      op: 'append',
      update: { part_id: 'p2', content_type: 'text', text: '旧内容' },
    }));
    const replaced = t.translate(itemFrame(18, 'item.snapshot_replaced', 'agentMessage', {
      item_id: 'message-1',
      snapshot: { parts: [{ part_id: 'p2', content_type: 'text', text: '修正后的内容' }] },
    }));

    expect(replaced?.EventType).toBe('assistant_stream_snapshot');
    expect(replaced?.Content).toEqual({ parts: [{ text: '修正后的内容' }] });
    expect(replaced?.Metadata?.RuntimeItem).toMatchObject({
      ItemId: 'message-1',
      PartId: 'p2',
      Operation: 'replace',
    });
  });

  it('atomically replaces an open reasoning item snapshot', () => {
    const t = new KernelRunEventTranslator('sess-1');
    const replaced = t.translate(itemFrame(19, 'item.snapshot_replaced', 'reasoning', {
      item_id: 'reasoning-1',
      snapshot: { parts: [{ part_id: 'rp1', content_type: 'text', text: '新的推理摘要' }] },
    }));

    expect(replaced?.EventType).toBe('reasoning');
    expect(replaced?.Content).toEqual({ parts: [{ text: '新的推理摘要' }] });
    expect(replaced?.Metadata?.RuntimeItem).toMatchObject({
      ItemId: 'reasoning-1',
      PartId: 'rp1',
      Operation: 'replace',
    });
  });

  it('translates interaction frames verbatim for the interaction adapter', () => {
    const t = new KernelRunEventTranslator('sess-1');
    const record = t.translate({
      seq: 6,
      family: 'interaction',
      family_version: 1,
      event_type: 'interaction.requested',
      interaction_id: 'item_abc',
      kind: 'approval',
      run_id: 'run-1',
    });
    expect(record?.EventType).toBe('interaction.requested');
    expect((record?.payload as Record<string, unknown>)?.interaction_id).toBe('item_abc');
  });

  it('maps terminal control run transitions to run_status', () => {
    const t = new KernelRunEventTranslator('sess-1');
    const record = t.translate({
      seq: 22,
      family: 'control',
      event_type: 'control.run_transition',
      state: 'completed',
      run_id: 'run-1',
    });
    expect(record?.EventType).toBe('run_status');
    expect(record?.Content).toEqual({ status: 'completed' });
  });

  it('maps tool items to tool_call / tool_result with call_id pairing', () => {
    const t = new KernelRunEventTranslator('sess-1');
    const started = t.translate(
      itemFrame(13, 'item.started', 'commandExecution', {
        item_id: 'tool-1',
        initial: { parts: [{ part_id: 'p', content_type: 'data', data: { command: 'ls' } }] },
      }),
    );
    const completed = t.translate(
      itemFrame(14, 'item.completed', 'commandExecution', {
        item_id: 'tool-1',
        snapshot: { parts: [{ part_id: 'p', content_type: 'data', data: { exitCode: 0 } }] },
      }),
    );
    expect(started?.EventType).toBe('tool_call');
    expect(started?.Metadata?.call_id).toBe('tool-1');
    expect(started?.Metadata?.RuntimeItem).toMatchObject({
      ItemId: 'tool-1',
      Operation: 'replace',
    });
    expect(completed?.EventType).toBe('tool_result');
    expect(completed?.Metadata?.call_id).toBe('tool-1');
    expect(completed?.Metadata?.RuntimeItem).toMatchObject({
      ItemId: 'tool-1',
      Operation: 'completed',
    });
  });

  it('maps LangGraph RuntimeEvent v2 tool parts without native item metadata', () => {
    const t = new KernelRunEventTranslator('sess-1');
    const started = t.translate({
      seq: 30,
      family: 'runtime',
      event_type: 'item.started',
      event_id: 'event-tool-started',
      run_id: 'run-1',
      scope_id: 'scope-1',
      item_id: 'item-tool-call',
      item_kind: 'tool_call',
      initial: {
        parts: [{
          content_type: 'tool_call',
          part_id: 'tool_call',
          call_id: 'call-1',
          name: 'load_memory',
          arguments: { query: '*' },
        }],
      },
      source: { framework: 'langgraph', metadata: {} },
    });
    const completedCall = t.translate({
      seq: 31,
      family: 'runtime',
      event_type: 'item.completed',
      event_id: 'event-tool-call-completed',
      run_id: 'run-1',
      scope_id: 'scope-1',
      item_id: 'item-tool-call',
      item_kind: 'tool_call',
      snapshot: {
        parts: [{
          content_type: 'tool_call',
          part_id: 'tool_call',
          call_id: 'call-1',
          name: 'load_memory',
          arguments: { query: '*' },
        }],
      },
      source: { framework: 'langgraph', metadata: {} },
    });
    const completedResult = t.translate({
      seq: 32,
      family: 'runtime',
      event_type: 'item.completed',
      event_id: 'event-tool-result-completed',
      run_id: 'run-1',
      scope_id: 'scope-1',
      item_id: 'item-tool-result',
      item_kind: 'tool_result',
      snapshot: {
        parts: [{
          content_type: 'tool_result',
          part_id: 'tool_result',
          call_id: 'call-1',
          result: { memories: ['breakfast'] },
          is_error: false,
        }],
      },
      source: { framework: 'langgraph', metadata: {} },
    });

    expect(started).toMatchObject({
      EventType: 'tool_call',
      Metadata: {
        call_id: 'call-1',
        tool_name: 'load_memory',
        tool_args: { query: '*' },
        RuntimeItem: { ItemId: 'call-1', Operation: 'replace' },
      },
    });
    expect(completedCall).toMatchObject({
      EventType: 'tool_call',
      Metadata: { RuntimeItem: { ItemId: 'call-1', Operation: 'replace' } },
    });
    expect(completedResult).toMatchObject({
      EventType: 'tool_result',
      Metadata: {
        call_id: 'call-1',
        tool_name: 'load_memory',
        tool_output: { memories: ['breakfast'] },
        RuntimeItem: { ItemId: 'call-1', Operation: 'completed' },
      },
    });
  });

  it('settles a Codex tool_call item whose completed snapshot includes its result', () => {
    const t = new KernelRunEventTranslator('sess-1');
    t.translate({
      seq: 40,
      family: 'runtime',
      event_type: 'item.started',
      event_id: 'event-command-started',
      run_id: 'run-1',
      scope_id: 'scope-1',
      item_id: 'item-command',
      item_kind: 'tool_call',
      initial: {
        parts: [{
          content_type: 'tool_call',
          part_id: 'command-call',
          call_id: 'call-command',
          name: 'codex.command',
          arguments: { command: 'echo hello' },
        }],
      },
      source: { framework: 'codex', metadata: { native_item_kind: 'commandExecution' } },
    });

    const completed = t.translate({
      seq: 41,
      family: 'runtime',
      event_type: 'item.completed',
      event_id: 'event-command-completed',
      run_id: 'run-1',
      scope_id: 'scope-1',
      item_id: 'item-command',
      item_kind: 'tool_call',
      snapshot: {
        parts: [
          {
            content_type: 'tool_call',
            part_id: 'command-call',
            call_id: 'call-command',
            name: 'codex.command',
            arguments: { command: 'echo hello' },
          },
          {
            content_type: 'tool_result',
            part_id: 'command-result',
            call_id: 'call-command',
            result: { exit_code: 0, output: 'hello\n' },
            is_error: false,
          },
        ],
      },
      source: { framework: 'codex', metadata: { native_item_kind: 'commandExecution' } },
    });

    expect(completed).toMatchObject({
      EventType: 'tool_result',
      Metadata: {
        call_id: 'call-command',
        tool_name: 'codex.command',
        tool_output: { exit_code: 0, output: 'hello\n' },
        RuntimeItem: { ItemId: 'call-command', Operation: 'completed' },
      },
    });
  });

  it('settles a failed tool item as an identity-bound error result', () => {
    const t = new KernelRunEventTranslator('sess-1');
    const failed = t.translate(itemFrame(20, 'item.failed', 'commandExecution', {
      item_id: 'tool-1',
      error: { code: 'command_failed', message: 'permission denied' },
    }));

    expect(failed?.EventType).toBe('tool_result');
    expect(failed?.Metadata?.call_id).toBe('tool-1');
    expect(failed?.Metadata?.tool_output).toEqual({
      error: { code: 'command_failed', message: 'permission denied' },
    });
    expect(failed?.Metadata?.RuntimeItem).toMatchObject({
      ItemId: 'tool-1',
      Operation: 'completed',
    });
  });

  it('keeps Codex MCP failures on the original call identity and name', () => {
    const t = new KernelRunEventTranslator('sess-1');
    const started = t.translate({
      seq: 40,
      family: 'runtime',
      event_type: 'item.started',
      event_id: 'event-mcp-started',
      run_id: 'run-1',
      scope_id: 'scope-1',
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
      source: { metadata: { native_item_kind: 'mcpToolCall' } },
    });
    const updated = t.translate({
      seq: 41,
      family: 'runtime',
      event_type: 'item.updated',
      event_id: 'event-mcp-updated',
      run_id: 'run-1',
      scope_id: 'scope-1',
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
      source: { metadata: { native_item_kind: 'mcpToolCall' } },
    });
    const failed = t.translate({
      seq: 42,
      family: 'runtime',
      event_type: 'item.failed',
      event_id: 'event-mcp-failed',
      run_id: 'run-1',
      scope_id: 'scope-1',
      item_id: 'item-mcp-tool',
      item_kind: 'tool_call',
      error: { code: 'codex_mcp_tool_failed', message: 'Codex mcpToolCall failed' },
      source: { metadata: { native_item_kind: 'mcpToolCall' } },
    });

    expect(started?.Metadata).toMatchObject({
      call_id: 'call-mcp-tool',
      tool_name: 'mcp.metaso-inner.metaso_topic_list',
      RuntimeItem: { ItemId: 'call-mcp-tool' },
    });
    expect(updated?.Metadata).toMatchObject({
      call_id: 'call-mcp-tool',
      tool_name: 'mcp.metaso-inner.metaso_topic_list',
      RuntimeItem: { ItemId: 'call-mcp-tool', Operation: 'completed' },
    });
    expect(failed?.Metadata).toMatchObject({
      call_id: 'call-mcp-tool',
      tool_name: 'mcp.metaso-inner.metaso_topic_list',
      tool_output: {
        error: { status: 'failed', error: { message: 'user rejected MCP tool call' } },
      },
      RuntimeItem: { ItemId: 'call-mcp-tool', Operation: 'completed' },
    });
  });

  it('skips control noise and non-runtime families', () => {
    const t = new KernelRunEventTranslator('sess-1');
    expect(t.translate({ seq: 1, family: 'control', event_type: 'control.command_accepted' })).toBeNull();
    expect(t.translate({ seq: 2 })).toBeNull();
  });
});

describe('peekKernelReceipt', () => {
  function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
  }

  it('detects the kernel receipt JSON body', async () => {
    const body = JSON.stringify({
      Code: 0,
      Message: 'Success',
      RequestId: 'r',
      Action: 'RunAgent',
      Data: { ReceiptStatus: 'accepted', MessageId: 'm1', RunId: null, AcceptedSeq: 5 },
    });
    const { receipt, stream } = await peekKernelReceipt(streamOf([body]));
    expect(receipt?.status).toBe('accepted');
    expect(receipt?.acceptedSeq).toBe(5);
    const text = await new Response(stream).text();
    expect(JSON.parse(text).Data.ReceiptStatus).toBe('accepted');
  });

  it('replays SSE bodies untouched', async () => {
    const sse = 'id: 1\ndata: {"foo":1}\n\n';
    const { receipt, stream } = await peekKernelReceipt(streamOf([sse]));
    expect(receipt).toBeNull();
    const text = await new Response(stream).text();
    expect(text).toBe(sse);
  });

  it('carries rejection errors through the receipt', async () => {
    const body = JSON.stringify({
      Code: 503,
      Data: { ReceiptStatus: 'rejected', Error: { code: 'runtime_not_ready', message: 'nope' } },
    });
    const { receipt } = await peekKernelReceipt(streamOf([body]));
    expect(receipt?.status).toBe('rejected');
    expect(receipt?.error?.message).toBe('nope');
  });
});
