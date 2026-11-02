import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatMessageList } from '../components/chat/ChatMessageList.js';
import type { Message } from '../components/chat/types.js';
import type { RunActivity } from '../stores/streaming.js';
import { runProgressLabel } from '../utils/run-progress.js';

const activity: RunActivity = { runId: 'current', source: 'run', status: 'running',
  phase: '等待会话输出', startedAt: 1, lastEventAt: 1, eventCount: 0 };
const messages: Message[] = [{ id: 'user', role: 'user', content: '查询', timestamp: 1 },
  { id: 'output', role: 'model', runId: 'current', content: '先查询记录。', reasoning: '核对查询范围', timestamp: 2,
    blocks: [
      { id: 'reasoning', type: 'thinking', content: '核对查询范围', status: 'done' },
      { id: 'tool', type: 'tool', toolName: 'lookup', args: '{"range":"week"}', status: 'running' },
    ] }];
const label = (overrides: Partial<Parameters<typeof runProgressLabel>[0]> = {}) =>
  runProgressLabel({ isStreaming: true, activity, messages, ...overrides });

describe('minimal trailing run feedback', () => {
  it('keeps a quiet tool visible without a timer or synthetic progress', () => {
    expect(label()).toBe('正在等待工具返回…');
    expect(label({ activity: { ...activity, startedAt: 0, lastEventAt: 0 } })).toBe(label());
  });

  it.each(['completed', 'failed', 'stopped'] as const)('hides a %s run even if its tool snapshot is still open', status => {
    expect(label({ activity: { ...activity, status } })).toBeNull();
  });

  it('hides settled transport output and does not turn history into a live run', () => {
    expect(label({ isStreaming: false })).toBeNull();
    expect(label({ isStreaming: false, activity: null })).toBeNull();
  });

  it('does not borrow an earlier turn or a queued turn to describe the active run', () => {
    const rows: Message[] = [...messages, { id: 'queued', role: 'user', content: '下一项', timestamp: 3 }];
    expect(label({ messages: rows })).toBe('正在等待工具返回…');
    expect(label({ activity: { ...activity, runId: 'new' }, messages: rows })).toBe('正在思考…');
  });

  it.each([
    ['网络异常，尝试重连', '连接中断，正在重连…'],
    ['恢复连接中', '连接中断，正在重连…'],
    ['正在同步任务进展', '正在同步任务进展…'],
    ['正在确认任务状态', '正在确认任务状态…'],
    ['运行已入队，等待执行', '正在等待执行…'],
    ['等待人工确认', '等待你的确认…'],
  ])('prioritizes %s over a cached running tool', (phase, expected) => {
    expect(label({ activity: { ...activity, phase } })).toBe(expected);
  });

  it('does not claim a finished tool is still working while the run continues', () => {
    const rows: Message[] = [{ ...messages[1], blocks: [
      { id: 'tool', type: 'tool', toolName: 'lookup', args: '{}', output: '结果', status: 'completed' },
    ] }];
    expect(label({ messages: rows })).toBe('正在处理…');
  });

  it('adds one footer after existing reasoning and tools without replacing their renderers', () => {
    const html = renderToStaticMarkup(<ChatMessageList agentName="Agent" isMobile={false}
      isStreaming activity={activity} contextIndicator={null} messages={messages}
      scrollRef={createRef()} onOpenAttachmentPreview={() => {}} onRespondToApproval={() => {}}
      onSubmitFeedback={() => {}} onDeleteFeedback={() => {}} />);
    expect(html.match(/data-testid="run-progress-indicator"/g)).toHaveLength(1);
    expect(html).toContain('processing-blocks');
    expect(html).toContain('已思考');
    expect(html).toContain('lookup');
    expect(html).toContain('正在运行');
    expect(html).toContain('正在等待工具返回…');
    expect(html.indexOf('run-progress-indicator')).toBeGreaterThan(html.indexOf('lookup'));
    expect(html).not.toMatch(/已运行|耗时|执行详情|RunActivityBanner/);
  });
});
