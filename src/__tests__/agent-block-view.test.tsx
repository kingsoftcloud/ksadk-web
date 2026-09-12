import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentBlockView } from '../components/chat/AgentBlockView';
import type { ConversationItem } from '../core/conversation/types';
const item: ConversationItem = {
  apiVersion: 'conversation.ksadk.io/v1',
  kindVersion: 1,
  kind: 'agent',
  itemId: 'agent',
  sessionId: 'session',
  runId: 'run',
  parentItemId: 'trigger',
  sourceEventIds: ['event'],
  operation: 'replace',
  lifecycle: 'streaming',
  visibility: 'public',
  payloadSchemaRef: 'conversation.item.agent/v1',
  nativeRef: {},
  payload: {
    schema: 'execution.scope/v1',
    scope_id: 'child',
    parent_scope_id: 'root',
    trigger_ref: { scope_id: 'root', item_id: 'trigger', call_id: 'call' },
    binding_id: 'binding',
    agent: { name: 'Finance' },
    status: 'working',
    cancel: { capability: 'unsupported', request_state: 'none' },
  },
};
describe('AgentBlockView', () => {
  it.each([
    'submitted',
    'working',
    'input_required',
    'completed',
    'failed',
    'cancelled',
  ])('renders truthful %s status collapsed by default', (status) => {
    const html = renderToStaticMarkup(
      <AgentBlockView
        block={{
          item: { ...item, payload: { ...item.payload, status } },
          messages: [
            {
              id: 'message',
              role: 'model',
              content: 'private collapsed detail',
              timestamp: 0,
            },
          ],
        }}
      />,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(
      {
        submitted: '已提交',
        working: '正在处理',
        input_required: '等待输入',
        completed: '已完成',
        failed: '执行失败',
        cancelled: '已取消',
      }[status]!,
    );
    expect(html).not.toContain('private collapsed detail');
    expect(html).not.toContain('Cancel remote agent');
  });
});

afterEach(() => vi.useRealTimers());
it('shows a safe summary and elapsed time while remaining collapsed', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1011000));
  const html = renderToStaticMarkup(
    <AgentBlockView
      block={{
        item: {
          ...item,
          payload: { ...item.payload, started_at: 1004, ended_at: null },
        },
        messages: [],
        summary: '已获取公开指标',
      }}
    />,
  );
  expect(html).toContain('已获取公开指标');
  expect(html).toContain('7 秒');
  expect(html).not.toContain('agent-block-detail');
});
it.each(['completed', 'failed', 'cancelled'])(
  'retains bounded elapsed duration for %s',
  (status) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(5000000));
    const html = renderToStaticMarkup(
      <AgentBlockView
        block={{
          item: {
            ...item,
            payload: {
              ...item.payload,
              status,
              started_at: 1004,
              ended_at: 1019,
            },
          },
          messages: [],
        }}
      />,
    );
    expect(html).toContain('15 秒');
    expect(html).not.toContain('agent-block-summary');
  },
);
it('does not invent duration from missing or reversed terminal timestamps', () => {
  for (const ended_at of [undefined, 999]) {
    const html = renderToStaticMarkup(
      <AgentBlockView
        block={{
          item: {
            ...item,
            payload: {
              ...item.payload,
              status: 'completed',
              started_at: 1004,
              ended_at,
            },
          },
          messages: [],
        }}
      />,
    );
    expect(html).not.toContain('agent-block-elapsed');
  }
});
