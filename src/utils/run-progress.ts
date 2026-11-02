import type { Message } from '../components/chat/types.js';
import type { Interaction } from '../core/interaction/types.js';
import type { RunActivity } from '../stores/streaming.js';

/** Presentation only: a quiet stream is still active until its owner settles it. */
export function runProgressLabel({
  isStreaming,
  activity,
  messages,
  interactions = [],
}: {
  isStreaming: boolean;
  activity: RunActivity | null;
  messages: readonly Message[];
  interactions?: readonly Interaction[];
}): string | null {
  if (!isStreaming || (activity && ['completed', 'failed', 'stopped'].includes(activity.status))) return null;

  const phase = activity?.phase || '';
  if (/重连|恢复连接|网络异常/.test(phase)) return '连接中断，正在重连…';
  if (/同步|恢复.*进展/.test(phase)) return '正在同步任务进展…';
  if (/确认.*状态/.test(phase)) return '正在确认任务状态…';
  if (/上传/.test(phase)) return '正在上传附件…';
  if (/入队|排队/.test(phase)) return '正在等待执行…';
  if (/创建会话|连接运行时|连接会话/.test(phase)) return '正在提交…';

  const runId = activity?.runId;
  if (/等待人工/.test(phase) || interactions.some(item =>
    item.status === 'pending' && (!runId || item.runId === runId))) return '等待你的确认…';

  const owned = runId ? messages.filter(message =>
    message.role === 'model' && (message.runId === runId || message.invocationId === runId)) : [];
  // Older transports have no item identities. Limit their fallback to the
  // current turn so a previous tool cannot become the new run's status.
  const lastUser = messages.findLastIndex(message => message.role === 'user');
  const current = owned.length ? owned : messages.slice(lastUser + 1).filter(message => message.role === 'model');
  const latest = current.at(-1);
  const block = latest?.blocks?.at(-1);
  if (block?.type === 'tool') {
    if (block.status === 'paused') return '等待你的确认…';
    if (block.status === 'running') return '正在等待工具返回…';
  } else if (block?.status === 'streaming') {
    if (block.type === 'thinking') return '正在思考…';
    if (block.type === 'text') return '正在生成回复…';
  }
  if (!latest?.blocks?.length) {
    const tools = Object.values(latest?.tools || {});
    if (tools.some(tool => tool.status === 'paused')) return '等待你的确认…';
    if (tools.some(tool => tool.status === 'running')) return '正在等待工具返回…';
    if (latest?.content) return '正在生成回复…';
    if (latest?.reasoning) return '正在思考…';
  }
  return current.some(message => message.content || message.reasoning || message.blocks?.length)
    ? '正在处理…' : '正在思考…';
}
