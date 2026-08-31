/**
 * 交错 "思考-行动-思考-输出" 渲染,照抄 Wegent/wework 的视觉节奏:
 * - 思考块:默认折叠；流式时只显示"思考中"动效，点击后才显示实时内容
 * - 工具块:单行活动行(图标+状态文案+duration),展开才出详情
 * - 正文块:平铺 markdown
 * 核心是"活动行优先、详情按需",不占大块视觉,保留时间线交错节奏。
 */

import { ChevronDown, FileDiff, Globe2, LoaderCircle, Sparkles, Wrench } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { MessageMarkdown } from '../MessageMarkdown';
import { parseUnifiedDiff, summarizeDiffSection, isUnifiedDiff } from '../../utils/parse-unified-diff';
import type { Message } from './types';
import type { ProcessingBlock, ThinkingBlock, ToolBlock, TextBlock } from '../../core/run/blocks';
import { InteractionHistoryAnchor } from './InteractionHistoryAnchor';
import type { Interaction } from '../../core/interaction/types';

type ToolData = NonNullable<Message['tools']>[string];

interface Props {
  message: Message;
  isStreaming: boolean;
  onRespondToApproval?: (p: { approvalRequestId: string; approve: boolean; previousResponseId?: string }) => void;
  onRespondToAguiApproval?: (p: { interruptId: string; approve: boolean }) => void;
  /** Interaction/v1 records; when present the read-only anchor replaces inline approval buttons. */
  interactionRecords?: readonly Interaction[];
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

function ThinkingRow({ block }: { block: ThinkingBlock }) {
  const [open, setOpen] = useState(false);
  const generating = block.status === 'streaming';
  const len = block.content.length;
  const detailId = `${block.id}-thinking-detail`;

  // 思考正文会持续增量更新。默认折叠时不挂载正文，避免“思考中”
  // 状态行变成不断闪动的预览；用户展开后才阅读实时详情。
  return (
    <div className="mb-1.5 min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-[13px] leading-5 text-slate-400 transition-colors hover:bg-slate-100/70 hover:text-slate-500 dark:text-slate-500 dark:hover:bg-slate-800/40 dark:hover:text-slate-400"
      >
        {!generating && <Sparkles className="h-3.5 w-3.5 shrink-0" />}
        <span
          className={cn('min-w-0 truncate', generating && 'waiting-thinking-text')}
          data-testid={generating ? 'thinking-indicator' : undefined}
          role={generating ? 'status' : undefined}
        >
          {generating ? '正在思考' : '已思考'}
        </span>
        {!generating && (
          <>
            <span className="text-slate-300 dark:text-slate-600">·</span>
            <span className="font-mono text-xs text-slate-400 dark:text-slate-500">{len} 字</span>
          </>
        )}
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && block.content && (
        <div
          id={detailId}
          className="custom-scrollbar mt-1.5 max-h-[min(46vh,28rem)] overflow-y-auto border-l border-slate-200/80 pl-3.5 text-[12px] leading-5 text-slate-500 dark:border-slate-700/60 dark:text-slate-400 [&_h1]:!mb-2 [&_h1]:!mt-3 [&_h1]:!text-[13px] [&_h2]:!mb-1.5 [&_h2]:!mt-3 [&_h2]:!text-[12px] [&_h3]:!mb-1 [&_h3]:!mt-2.5 [&_h3]:!text-[12px] [&_li]:!text-[12px] [&_li]:!leading-5 [&_p]:!my-1.5 [&_p]:!text-[12px] [&_p]:!leading-5 [&_p]:!text-slate-500 dark:[&_p]:!text-slate-400 [&_pre]:!my-1.5"
        >
          <MessageMarkdown content={block.content} />
        </div>
      )}
    </div>
  );
}

function ToolRow({
  block,
  tool,
  isStreaming,
  interactionRecord,
  onRespondToApproval,
  onRespondToAguiApproval,
}: {
  block: ToolBlock;
  tool?: ToolData;
  isStreaming: boolean;
  /** The composer tray owns all interaction decisions once normalized. */
  interactionRecord?: Interaction;
  onRespondToApproval?: Props['onRespondToApproval'];
  onRespondToAguiApproval?: Props['onRespondToAguiApproval'];
}) {
  const status = tool?.status ?? block.status;
  const args = tool?.args ?? block.args;
  const output = tool?.output ?? block.output;
  // 审批字段优先从 block.extra 读(approval_requested 同步写进 blocks,key=toolName 一致);
  // fallback 从 tool 读(旧路径,msg.tools 用 approvalRequestId 做 key 可能和 toolName 不一致。
  const extra = (block.extra || {}) as Record<string, unknown>;
  const approvalStatus = (extra.approvalStatus as string) || tool?.approvalStatus;
  const approvalRequestId = (extra.approvalRequestId as string) || tool?.approvalRequestId;
  const approvalMessage = (extra.approvalMessage as string) || tool?.approvalMessage;
  const approvalProtocol = (extra.approvalProtocol as string) || tool?.approvalProtocol;
  const previousResponseId = (extra.previousResponseId as string) || tool?.previousResponseId;
  const running = status === 'running';
  const errored = status === 'error';
  const paused = status === 'paused';

  // Approval is an audit trail. The execution result is the primary state,
  // otherwise an earlier “approved” label can hide a later tool failure.
  const prefix = errored
    ? '执行失败'
    : approvalStatus === 'pending'
      ? '等待确认'
      : approvalStatus === 'rejected'
        ? '已拒绝'
        : running
          ? approvalStatus === 'approved' ? '已授权 · 执行中' : '正在运行'
          : approvalStatus === 'approved'
            ? '已授权'
            : paused
              ? '已暂停'
              : '已完成';

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
        {approvalRequestId && approvalStatus === 'pending' && !interactionRecord && (
          <section className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-slate-200/90 bg-white/70 px-2.5 py-2 font-sans text-[12px] text-slate-600 shadow-[0_1px_2px_rgba(15,23,42,0.03)] dark:border-slate-700/80 dark:bg-slate-900/30 dark:text-slate-300">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" aria-hidden="true" />
              <span className="shrink-0 font-medium text-slate-700 dark:text-slate-200">需要确认</span>
              <span className="min-w-0 truncate text-slate-500 dark:text-slate-400">{approvalMessage || '允许后将执行此工具调用。'}</span>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  disabled={isStreaming}
                  onClick={() =>
                    approvalProtocol === 'ag-ui'
                      ? onRespondToAguiApproval?.({ interruptId: approvalRequestId || '', approve: true })
                      : onRespondToApproval?.({ approvalRequestId: approvalRequestId || '', approve: true, previousResponseId })
                  }
                  className="inline-flex h-7 items-center rounded-md bg-primary px-2.5 text-[12px] font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-55"
                >
                  允许执行
                </button>
                <button
                  type="button"
                  disabled={isStreaming}
                  onClick={() =>
                    approvalProtocol === 'ag-ui'
                      ? onRespondToAguiApproval?.({ interruptId: approvalRequestId || '', approve: false })
                      : onRespondToApproval?.({ approvalRequestId: approvalRequestId || '', approve: false, previousResponseId })
                  }
                  className="inline-flex h-7 items-center rounded-md px-2 text-[12px] font-medium text-slate-500 transition hover:bg-slate-100 hover:text-rose-600 disabled:opacity-55 dark:text-slate-400 dark:hover:bg-slate-800"
                >
                  拒绝
                </button>
            </div>
          </section>
        )}
        {approvalRequestId && approvalStatus === 'pending' && interactionRecord ? (
          <div className="flex items-center gap-1.5 font-sans text-xs text-slate-500 dark:text-slate-400">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" aria-hidden="true" />
            请在输入区确认面板中操作。
          </div>
        ) : null}
        {approvalRequestId && approvalStatus && approvalStatus !== 'pending' && (
          <div className="flex items-center gap-1.5 font-sans text-xs text-slate-500 dark:text-slate-400">
            <span>{approvalStatus === 'approved' ? '已授权' : '已拒绝'}</span>
            {approvalStatus === 'approved' && running ? <span>· 工具执行中</span> : null}
            {approvalStatus === 'approved' && errored ? <span>· 工具执行失败</span> : null}
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
  // 正文块走 MessageMarkdown:流式时标题/列表/粗体/代码块即时渲染。
  return (
    <div className="w-full break-words py-0.5 text-[14px] leading-[1.65]">
      <MessageMarkdown content={block.content} />
    </div>
  );
}

export function ProcessingBlocksView({
  message,
  isStreaming,
  onRespondToApproval,
  onRespondToAguiApproval,
  interactionRecords,
}: Props) {
  const blocks: ProcessingBlock[] = message.blocks ?? [];
  return (
    <div className="mb-3 min-w-0">
      {blocks.map((block) => {
        if (block.type === 'thinking') {
          return <ThinkingRow key={block.id} block={block} />;
        }
        if (block.type === 'tool') {
          const blockExtra = (block.extra || {}) as Record<string, unknown>;
          const approvalId = String(
            blockExtra.approvalRequestId
            || message.tools?.[block.toolName]?.approvalRequestId
            || '',
          );
          const record = approvalId
            ? interactionRecords?.find((entry) => entry.interactionId === approvalId)
            : undefined;
          return (
            <div key={block.id}>
              <ToolRow
                block={block}
                tool={message.tools?.[block.toolName]}
                isStreaming={isStreaming}
                interactionRecord={record}
                onRespondToApproval={onRespondToApproval}
                onRespondToAguiApproval={onRespondToAguiApproval}
              />
              {record ? <InteractionHistoryAnchor interaction={record} /> : null}
            </div>
          );
        }
        return <TextRow key={block.id} block={block} />;
      })}
    </div>
  );
}
