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
      itemFrame(11, 'item.updated', 'agentMessage', { op: 'replace', ...AGENT_SNAPSHOT('你好') }),
    );
    const second = t.translate(
      itemFrame(12, 'item.updated', 'agentMessage', { op: 'append', ...AGENT_SNAPSHOT('，世界') }),
    );
    expect(first?.Content).toEqual({ parts: [{ text: '你好' }] });
    expect(second?.Content).toEqual({ parts: [{ text: '你好，世界' }] });
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
    expect(record?.event_type).toBe('interaction.requested');
    expect(record?.interaction_id).toBe('item_abc');
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
    expect(completed?.EventType).toBe('tool_result');
    expect(completed?.Metadata?.call_id).toBe('tool-1');
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
