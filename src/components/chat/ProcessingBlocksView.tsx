/**
 * 交错 "思考-行动-思考-输出" 渲染,照抄 Wegent/wework 的视觉节奏:
 * - 思考块:流式→单行"思考中 · 预览"(shimmer);完成→单行"已思考 · N字"+chevron 展开
 * - 工具块:单行活动行(图标+状态文案+duration),展开才出详情
 * - 正文块:平铺 markdown
 * 核心是"活动行优先、详情按需",不占大块视觉,保留时间线交错节奏。
 */

import { ChevronDown, FileDiff, Globe2, LoaderCircle, Brain, Wrench } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { MessageMarkdown } from '../MessageMarkdown';
import { parseUnifiedDiff, summarizeDiffSection, isUnifiedDiff } from '../../utils/parse-unified-diff';
import type { Message } from './types';
import type { ProcessingBlock, ThinkingBlock, ToolBlock, TextBlock } from '../../core/run/blocks';

type ToolData = NonNullable<Message['tools']>[string];

interface Props {
  message: Message;
  isStreaming: boolean;
  onRespondToApproval?: (p: { approvalRequestId: string; approve: boolean; previousResponseId?: string }) => void;
  onRespondToAguiApproval?: (p: { interruptId: string; approve: boolean }) => void;
}

/** 折叠容器:单行 summary + 可展开详情,260ms 高度动画。 */
function Collapsible({
  summary,
  children,
  defaultOpen = false,
  streaming = false,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  streaming?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mb-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-[13px] text-slate-500 transition-colors hover:bg-slate-100/70 dark:text-slate-400 dark:hover:bg-slate-800/40"
      >
        {streaming ? (
          <LoaderCircle className="h-3.5 w-3.5 animate-spin text-slate-400" />
        ) : (
          <ChevronDown className={cn('h-3.5 w-3.5 text-slate-400 transition-transform', open && 'rotate-90')} />
        )}
        <span className="min-w-0 flex-1 truncate">{summary}</span>
      </button>
      {open && (
        <div className="mt-1.5 border-l border-slate-200 pl-3.5 dark:border-slate-700/60">
          {children}
        </div>
      )}
    </div>
  );
}

/** 去 markdown 标记取末句预览(粗略:取最后一段非空文本)。 */
function plainPreview(text: string, max = 96): string {
  const stripped = text.replace(/[#*`>\-]/g, '').replace(/\s+/g, ' ').trim();
  if (stripped.length <= max) return stripped;
  return stripped.slice(-max);
}

function ThinkingRow({ block }: { block: ThinkingBlock }) {
  const generating = block.status === 'streaming';
  if (generating) {
    // 流式:单行"思考中 · 预览",不折叠,带 shimmer
    const preview = plainPreview(block.content);
    return (
      <div className="mb-1.5 flex items-center gap-1.5 px-1 py-1 text-[13px] text-slate-400 dark:text-slate-500">
        <Brain className="h-3.5 w-3.5 shrink-0" />
        <span className="animate-pulse">思考中</span>
        {preview && (
          <>
            <span className="text-slate-300 dark:text-slate-600">·</span>
            <span className="min-w-0 flex-1 truncate">{preview}</span>
          </>
        )}
      </div>
    );
  }
  // 完成:单行"已思考 · N字"+chevron 展开
  const len = block.content.length;
  return (
    <Collapsible
      summary={
        <span className="flex items-center gap-1.5">
          <Brain className="h-3.5 w-3.5 text-slate-400" />
          <span>已思考</span>
          <span className="text-slate-300 dark:text-slate-600">·</span>
          <span className="font-mono text-xs text-slate-400">{len} 字</span>
        </span>
      }
    >
      <div className="custom-scrollbar max-h-[min(46vh,28rem)] overflow-y-auto py-1 text-[14px] leading-7 text-slate-600 dark:text-slate-300 [&_p]:my-2 [&_pre]:my-2">
        <MessageMarkdown content={block.content} />
      </div>
    </Collapsible>
  );
}

function ToolRow({
  block,
  tool,
  isStreaming,
  onRespondToApproval,
  onRespondToAguiApproval,
}: {
  block: ToolBlock;
  tool?: ToolData;
  isStreaming: boolean;
  onRespondToApproval?: Props['onRespondToApproval'];
  onRespondToAguiApproval?: Props['onRespondToAguiApproval'];
}) {
  const status = tool?.status ?? block.status;
  const args = tool?.args ?? block.args;
  const output = tool?.output ?? block.output;
  const approvalStatus = tool?.approvalStatus;
  const approvalRequestId = tool?.approvalRequestId;
  const approvalMessage = tool?.approvalMessage;
  const approvalProtocol = tool?.approvalProtocol;
  const previousResponseId = tool?.previousResponseId;
  const running = status === 'running';
  const errored = status === 'error';
  const paused = status === 'paused';

  // 状态文案前缀(wework 风格:文案承载状态,不用胶囊)
  const prefix = approvalStatus === 'pending'
    ? '等待审批'
    : approvalStatus === 'approved'
      ? '已批准'
      : approvalStatus === 'rejected'
        ? '已拒绝'
        : running
          ? '正在运行'
          : errored
            ? '运行失败'
            : paused
              ? '已暂停'
              : '已运行';

  const tone = errored
    ? 'text-rose-500 dark:text-rose-400'
    : paused
      ? 'text-amber-500 dark:text-amber-400'
      : running
        ? 'text-slate-500 dark:text-slate-400'
        : 'text-slate-400 dark:text-slate-500';

  return (
    <Collapsible
      streaming={running && !args /* 还没拿到参数时折叠头转圈 */}
      defaultOpen={approvalStatus === 'pending' || paused}
      summary={
        <span className="flex items-center gap-1.5">
          <Wrench className={cn('h-3.5 w-3.5 shrink-0', tone)} />
          <span className={tone}>{prefix}</span>
          <span className="truncate font-medium text-slate-600 dark:text-slate-300">{block.toolName}</span>
          {running && args && <span className="ml-0.5 animate-pulse text-slate-400">…</span>}
        </span>
      }
    >
      <div className="flex flex-col gap-2.5 py-1 text-[13px]">
        {approvalRequestId && (
          <div className="font-sans text-[13px] text-slate-700 dark:text-slate-200">
            <div className="font-medium">
              {approvalStatus === 'approved'
                ? '已批准该工具调用。'
                : approvalStatus === 'rejected'
                  ? '已拒绝该工具调用。'
                  : approvalMessage || '该工具调用需要人工确认后继续。'}
            </div>
            {approvalStatus === 'pending' && (
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={isStreaming}
                  onClick={() =>
                    approvalProtocol === 'ag-ui'
                      ? onRespondToAguiApproval?.({ interruptId: approvalRequestId || '', approve: true })
                      : onRespondToApproval?.({ approvalRequestId: approvalRequestId || '', approve: true, previousResponseId })
                  }
                  className="inline-flex h-8 items-center gap-1.5 rounded-full bg-foreground px-4 text-xs font-semibold text-background transition hover:opacity-80 disabled:opacity-55"
                >
                  批准并继续
                </button>
                <button
                  type="button"
                  disabled={isStreaming}
                  onClick={() =>
                    approvalProtocol === 'ag-ui'
                      ? onRespondToAguiApproval?.({ interruptId: approvalRequestId || '', approve: false })
                      : onRespondToApproval?.({ approvalRequestId: approvalRequestId || '', approve: false, previousResponseId })
                  }
                  className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border px-4 text-xs font-semibold text-text-secondary transition hover:border-rose-300 hover:text-rose-600 disabled:opacity-55"
                >
                  拒绝
                </button>
              </div>
            )}
          </div>
        )}
        {args ? <PayloadBlock label="入参" value={args} tone="input" /> : null}
        {output ? renderToolOutput(block.toolName, output, errored) : null}
      </div>
    </Collapsible>
  );
}

/** 按 tool name + output 内容识别渲染:diff→文件改动卡,web search→来源 chip,否则通用 PayloadBlock。 */
function renderToolOutput(toolName: string, output: string, errored: boolean): ReactNode {
  if (isUnifiedDiff(output)) {
    return <FileChangesCard output={output} />;
  }
  const name = toolName.toLowerCase();
  if (name.includes('web_search') || name.includes('search')) {
    const sources = parseWebSearchSources(output);
    if (sources.length > 0) return <WebSearchSourcesChip sources={sources} />;
  }
  return <PayloadBlock label="输出" value={output} tone={errored ? 'error' : 'output'} />;
}

/** 轻量文件改动卡:解析 unified diff 成文件行,显示路径 + +/− 统计(wework FileChangesCard 简化版)。 */
function FileChangesCard({ output }: { output: string }) {
  const sections = parseUnifiedDiff(output);
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? sections : sections.slice(0, 3);
  return (
    <div className="my-2 overflow-hidden rounded-xl border border-border bg-background">
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-xs font-medium text-text-secondary">
        <FileDiff className="h-3.5 w-3.5 text-primary" />
        <span>改动 {sections.length} 个文件</span>
      </div>
      <div className="flex flex-col">
        {visible.map((section) => {
          const { added, removed } = summarizeDiffSection(section);
          return (
            <div
              key={section.path}
              className="group/file-change-row flex min-w-0 items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-muted"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-text-primary">{section.path}</span>
              <span className="flex-shrink-0 text-[11px] font-mono">
                <span className="text-emerald-600">+{added}</span>{' '}
                <span className="text-rose-500">−{removed}</span>
              </span>
            </div>
          );
        })}
      </div>
      {sections.length > 3 ? (
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="flex w-full items-center justify-center gap-1 border-t border-border py-1.5 text-xs text-text-muted transition hover:bg-muted hover:text-text-primary"
        >
          {expanded ? '收起' : `展开剩余 ${sections.length - 3} 个文件`}
        </button>
      ) : null}
    </div>
  );
}

/** 尝试从 tool output 解析 web search 来源(JSON 含 url/title 数组,否则空)。 */
function parseWebSearchSources(output: string): { url: string; title: string }[] {
  try {
    const parsed = JSON.parse(output);
    const arr = Array.isArray(parsed) ? parsed : parsed?.results ?? parsed?.sources ?? [];
    if (!Array.isArray(arr)) return [];
    return arr
      .map((item: unknown) => {
        const obj = item as Record<string, unknown>;
        const url = String(obj?.url ?? obj?.link ?? obj?.href ?? '');
        const title = String(obj?.title ?? obj?.name ?? url);
        return url ? { url, title } : null;
      })
      .filter((s): s is { url: string; title: string } => s !== null);
  } catch {
    return [];
  }
}

/** 轻量搜索来源 chip:wework WebSearchSourcesChip 简化版,hover 弹来源列表。 */
function WebSearchSourcesChip({ sources }: { sources: { url: string; title: string }[] }) {
  return (
    <div className="mt-2 flex min-w-0">
      <span className="group/web-search-sources relative inline-flex min-w-0">
        <button
          type="button"
          className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-xs text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
        >
          <Globe2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.7} />
          <span>来源 · {sources.length}</span>
        </button>
        <span className="absolute bottom-full left-0 z-30 hidden max-w-[calc(100vw-3rem)] pb-1 group-hover/web-search-sources:block">
          <span className="block w-[min(26rem,calc(100vw-3rem))] rounded-xl border border-border bg-popover p-2 text-left text-text-primary shadow-2xl">
            <span className="flex min-w-0 flex-col gap-1">
              {sources.map((source, index) => (
                <a
                  key={`${source.url}-${index}`}
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-sm leading-5 text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
                >
                  <Globe2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.7} />
                  <span className="min-w-0 flex-1 truncate">{source.title}</span>
                </a>
              ))}
            </span>
          </span>
        </span>
      </span>
    </div>
  );
}

function PayloadBlock({ label, tone, value }: { label: string; tone: 'input' | 'output' | 'error'; value: string }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <pre
        className={cn(
          'custom-scrollbar max-h-60 overflow-auto rounded-lg px-3 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap break-all',
          tone === 'error'
            ? 'bg-rose-50/60 text-rose-700 dark:bg-rose-950/20 dark:text-rose-200'
            : tone === 'output'
              ? 'bg-emerald-50/40 text-emerald-800 dark:bg-emerald-950/20 dark:text-emerald-200'
              : 'bg-slate-50 text-slate-700 dark:bg-slate-900/40 dark:text-slate-200',
        )}
      >
        {value}
      </pre>
    </div>
  );
}

function TextRow({ block }: { block: TextBlock }) {
  if (!block.content) return null;
  // 正文块走 MessageMarkdown:流式时标题/列表/粗体/代码块即时渲染,
  // 不再用 whitespace-pre-line 纯文本(那会导致 # 标题 原样显示成文本)。
  // 单 \n 换行由 remark-breaks + p 块间距处理,不会挤一坨。
  return (
    <div className="w-full break-words py-0.5 text-[15px] leading-6">
      <MessageMarkdown content={block.content} />
    </div>
  );
}

export function ProcessingBlocksView({
  message,
  isStreaming,
  onRespondToApproval,
  onRespondToAguiApproval,
}: Props) {
  const blocks: ProcessingBlock[] = message.blocks ?? [];
  return (
    <div className="mb-3 min-w-0">
      {blocks.map((block) => {
        if (block.type === 'thinking') {
          return <ThinkingRow key={block.id} block={block} />;
        }
        if (block.type === 'tool') {
          return (
            <ToolRow
              key={block.id}
              block={block}
              tool={message.tools?.[block.toolName]}
              isStreaming={isStreaming}
              onRespondToApproval={onRespondToApproval}
              onRespondToAguiApproval={onRespondToAguiApproval}
            />
          );
        }
        return <TextRow key={block.id} block={block} />;
      })}
    </div>
  );
}
