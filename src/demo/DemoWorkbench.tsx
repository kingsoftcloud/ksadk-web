import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  Bot,
  CheckCircle2,
  Code2,
  LoaderCircle,
  Plus,
  Send,
  Sparkles,
  UserRound,
} from 'lucide-react';

import { MessageMarkdown } from '../components/MessageMarkdown';
import { ProcessingBlocksView } from '../components/chat/ProcessingBlocksView';
import type { Message } from '../components/chat/types';

const initialMessages: Message[] = [
  {
    id: 'welcome',
    role: 'model',
    content: '',
    timestamp: Date.now(),
    blocks: [
      {
        id: 'welcome-thinking',
        type: 'thinking',
        content: '确认这是不依赖后端的公开演示，并准备展示统一事件渲染。',
        status: 'done',
      },
      {
        id: 'welcome-tool',
        type: 'tool',
        toolName: 'demo.inspect_capabilities',
        args: '{"surface":"chat"}',
        output: '{"streaming":true,"reasoning":true,"tools":true}',
        status: 'completed',
      },
      {
        id: 'welcome-text',
        type: 'text',
        content: '这是 **ksadk-web 交互演示**。你可以发送一条消息，观察思考、工具和正文按同一事件时间线逐步出现。',
        status: 'done',
      },
    ],
  },
];

export function DemoWorkbench() {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const timers = useRef<number[]>([]);

  useEffect(() => () => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
  }, []);

  const schedule = (callback: () => void, delay: number) => {
    timers.current.push(window.setTimeout(callback, delay));
  };

  const updateResponse = (responseId: string, update: (message: Message) => Message) => {
    setMessages((current) => current.map((message) => (
      message.id === responseId ? update(message) : message
    )));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    if (!text || running) return;
    const stamp = Date.now();
    const responseId = `demo-response-${stamp}`;
    setInput('');
    setRunning(true);
    setMessages((current) => [
      ...current,
      { id: `demo-user-${stamp}`, role: 'user', content: text, timestamp: stamp },
      {
        id: responseId,
        role: 'model',
        content: '',
        timestamp: stamp + 1,
        blocks: [{
          id: `${responseId}-thinking`,
          type: 'thinking',
          content: '正在理解你的请求',
          status: 'streaming',
        }],
      },
    ]);

    schedule(() => updateResponse(responseId, (message) => ({
      ...message,
      blocks: [{
        id: `${responseId}-thinking`,
        type: 'thinking',
        content: '正在理解你的请求，并选择适合的演示工具。',
        status: 'streaming',
      }],
    })), 900);
    schedule(() => updateResponse(responseId, (message) => ({
      ...message,
      blocks: [
        {
          id: `${responseId}-thinking`,
          type: 'thinking',
          content: '已确认输入内容，接下来执行一个只读示例工具。',
          status: 'done',
        },
        {
          id: `${responseId}-tool`,
          type: 'tool',
          toolName: 'demo.echo_context',
          args: JSON.stringify({ input: text }, null, 2),
          status: 'running',
        },
      ],
      tools: {
        'demo.echo_context': {
          name: 'demo.echo_context',
          args: JSON.stringify({ input: text }, null, 2),
          status: 'running',
        },
      },
    })), 4000);
    schedule(() => updateResponse(responseId, (message) => ({
      ...message,
      blocks: [
        ...(message.blocks ?? []).map((block) => (
          block.type === 'tool' ? { ...block, output: '{"ok":true}', status: 'completed' as const } : block
        )),
        {
          id: `${responseId}-text`,
          type: 'text',
          content: `已收到：“${text}”。\n\n这个页面展示的是本地可交互事件流；接入真实 Agent 时，组件会消费同一套会话、思考、工具、审批与 A2UI 协议。`,
          status: 'done',
        },
      ],
      tools: {
        'demo.echo_context': {
          name: 'demo.echo_context',
          args: JSON.stringify({ input: text }, null, 2),
          output: '{"ok":true}',
          status: 'completed',
        },
      },
    })), 6500);
    schedule(() => setRunning(false), 6700);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  return (
    <div className="flex min-h-screen bg-slate-50 font-sans text-slate-800">
      <aside className="hidden w-72 shrink-0 border-r border-slate-200 bg-white lg:flex lg:flex-col">
        <div className="border-b border-slate-100 px-5 py-5">
          <div className="flex items-center gap-2.5 font-semibold">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-600 text-white">K</span>
            ksadk-web
          </div>
          <p className="mt-2 text-xs leading-5 text-slate-500">统一 Agent 会话组件</p>
        </div>
        <div className="p-3">
          <button className="w-full rounded-xl bg-blue-50 px-3 py-2.5 text-left text-sm font-medium text-blue-700">
            交互能力演示
          </button>
        </div>
        <div className="mt-auto border-t border-slate-100 p-4 text-xs leading-5 text-slate-500">
          <a className="flex items-center gap-2 hover:text-slate-800" href="https://github.com/kingsoftcloud/ksadk-web">
            <Code2 className="h-4 w-4" /> 查看源码与接入文档
          </a>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col bg-white">
        <header className="flex h-16 items-center justify-between border-b border-slate-100 px-5 sm:px-8">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-100 text-slate-600"><Bot className="h-4 w-4" /></span>
            <div>
              <h1 className="text-sm font-semibold">KsADK Web 示例 Agent</h1>
              <p className="text-xs text-slate-500">思考 · 工具 · Markdown · 会话状态</p>
            </div>
          </div>
          <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-700">本地交互演示</span>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-8 sm:px-8">
          <div className="mx-auto max-w-3xl space-y-6">
            <div className="rounded-2xl border border-blue-100 bg-blue-50/60 px-4 py-3 text-sm leading-6 text-blue-900">
              <div className="flex items-center gap-2 font-medium"><Sparkles className="h-4 w-4" /> 无需后端即可体验渲染</div>
              <p className="mt-1 text-xs text-blue-700/80">这是公开站点的示例数据，不会连接或冒充真实 Agent。生产接入请使用下方源码与文档。</p>
            </div>

            {messages.map((message, index) => message.role === 'user' ? (
              <div key={message.id} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-md bg-slate-100 px-4 py-3 text-sm leading-6">
                  <div className="mb-1 flex items-center justify-end gap-1.5 text-[11px] text-slate-500"><UserRound className="h-3 w-3" /> 你</div>
                  <MessageMarkdown content={message.content} />
                </div>
              </div>
            ) : (
              <div key={message.id} className="rounded-2xl border border-slate-100 bg-white px-4 py-4 shadow-sm shadow-slate-900/5">
                <div className="mb-2 flex items-center gap-2 text-xs font-medium text-slate-600"><Bot className="h-3.5 w-3.5" /> 示例 Agent</div>
                <ProcessingBlocksView message={message} isStreaming={running && index === messages.length - 1} />
              </div>
            ))}
          </div>
        </div>

        <div className="border-t border-slate-100 bg-white/95 px-4 py-4 backdrop-blur sm:px-8">
          <form onSubmit={submit} className="mx-auto max-w-3xl rounded-[24px] border border-slate-200 bg-white p-3 shadow-[0_8px_30px_rgba(15,23,42,0.08)] focus-within:border-blue-300 focus-within:ring-2 focus-within:ring-blue-100">
            <textarea
              aria-label="演示消息"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="输入消息，体验流式渲染…"
              rows={2}
              className="w-full resize-none border-0 px-2 py-1 text-sm leading-6 outline-none placeholder:text-slate-400"
            />
            <div className="mt-2 flex items-center justify-between">
              <button type="button" aria-label="添加附件（演示）" className="flex h-8 w-8 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100"><Plus className="h-4 w-4" /></button>
              <div className="flex items-center gap-2">
                {running ? <span className="flex items-center gap-1.5 text-xs text-slate-500"><LoaderCircle className="h-3.5 w-3.5 animate-spin" /> 运行中</span> : <span className="flex items-center gap-1.5 text-xs text-emerald-600"><CheckCircle2 className="h-3.5 w-3.5" /> 可发送</span>}
                <button
                  type="submit"
                  disabled={!input.trim() || running}
                  aria-label="发送演示消息"
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-200"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
            </div>
          </form>
          <p className="mx-auto mt-2 max-w-3xl text-center text-[11px] text-slate-400">演示仅在浏览器本地运行，不发送数据。</p>
        </div>
      </main>
    </div>
  );
}
