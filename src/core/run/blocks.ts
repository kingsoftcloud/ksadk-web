/**
 * 交错 "思考-行动-思考-输出" 的有序 block 模型(照抄 Wegent wework 的
 * workbench ProcessingBlock 方案,见 packages/chat-core/workbench-message-reducer.ts)。
 *
 * 核心思想:一条 assistant message 不是 "reasoning 单串 + tools map + content",
 * 而是一个**有序的 ProcessingBlock 数组**。思考块会被工具调用"切断"成多段,
 * 从而自然形成 [思考1][工具][思考2][正文] 的时间线交错布局。
 */

export type BlockStatus = 'streaming' | 'done' | 'error';

export interface ThinkingBlock {
  id: string;
  type: 'thinking';
  content: string;
  status: BlockStatus;
}

export interface ToolBlock {
  id: string;
  type: 'tool';
  toolName: string;
  args: string;
  output?: string;
  status: 'running' | 'completed' | 'error' | 'paused';
  /** 透传现有 Message.tools 的附加字段(approval 等),渲染层按需取。 */
  extra?: Record<string, unknown>;
}

export interface TextBlock {
  id: string;
  type: 'text';
  content: string;
  status: BlockStatus;
}

export type ProcessingBlock = ThinkingBlock | ToolBlock | TextBlock;

let blockSeq = 0;
function nextId(prefix: string): string {
  blockSeq += 1;
  return `${prefix}-${blockSeq}`;
}

/** 关闭所有仍处于 streaming 的 thinking 块(不动 text 块)。
 *  text 块的开关由 appendTextBlock/finalizeTextBlock 自管,这里不干预,
 *  否则会把流式 text 错误置 done,导致后续 delta 新建第二个 text 块(正文重复)。 */
function finalizeOpenThinkingBlocks(blocks: ProcessingBlock[]): ProcessingBlock[] {
  return blocks.map((block) =>
    block.type === 'thinking' && block.status === 'streaming'
      ? { ...block, status: 'done' as const }
      : block,
  );
}

/** 追加思考 delta(对应 wework appendThinkingChunk):
 *  最后一个块是流式 thinking 则追加,否则新建一个 thinking 块。 */
export function appendThinkingBlock(
  blocks: ProcessingBlock[] | undefined,
  delta: string,
): ProcessingBlock[] {
  const next = [...(blocks ?? [])];
  const last = next[next.length - 1];
  if (last?.type === 'thinking' && last.status === 'streaming') {
    next[next.length - 1] = { ...last, content: last.content + delta };
    return next;
  }
  return [
    ...next,
    { id: nextId('thinking'), type: 'thinking', content: delta, status: 'streaming' },
  ];
}

/** 追加正文 delta:先关闭打开的 thinking,再追加到最后一个流式 text 块(或新建)。 */
export function appendTextBlock(
  blocks: ProcessingBlock[] | undefined,
  delta: string,
): ProcessingBlock[] {
  const base = finalizeOpenThinkingBlocks(blocks ?? []);
  const next = [...base];
  const last = next[next.length - 1];
  if (last?.type === 'text' && last.status === 'streaming') {
    next[next.length - 1] = { ...last, content: last.content + delta };
    return next;
  }
  return [...next, { id: nextId('text'), type: 'text', content: delta, status: 'streaming' }];
}

/** 正文收尾(text_final):把最后一个流式 text 块设为终值并关闭。 */
export function finalizeTextBlock(
  blocks: ProcessingBlock[] | undefined,
  text: string,
): ProcessingBlock[] {
  const base = finalizeOpenThinkingBlocks(blocks ?? []);
  const streamedText = base
    .filter((block): block is TextBlock => block.type === 'text')
    .map((block) => block.content)
    .join('');

  // Responses 的 output_text.done 是整轮输出的终态快照。若它正好等于已经
  // 收到的 text delta 聚合，不能把它回填到最后一个块：这会把
  // [思考1][文本1][思考2][文本2] 错误折叠成最后一个混合文本块。
  if (streamedText === text) {
    return base.map((block) =>
      block.type === 'text' && block.status === 'streaming'
        ? { ...block, status: 'done' as const }
        : block,
    );
  }

  const next = [...base];
  const lastIndex = next.map((b) => b.type).lastIndexOf('text');
  if (lastIndex >= 0 && next[lastIndex].type === 'text') {
    next[lastIndex] = { ...(next[lastIndex] as TextBlock), content: text, status: 'done' };
    return next;
  }
  return [...next, { id: nextId('text'), type: 'text', content: text, status: 'done' }];
}

/**
 * Compatibility for runtimes that mislabeled a streamed final answer as the
 * tail of reasoning and only emitted the answer's authoritative snapshot at
 * completion. This is deliberately narrow: it touches only the last thinking
 * block and only when that block ends with the exact terminal answer.
 */
export function stripMirroredTerminalAnswerFromThinking(
  blocks: ProcessingBlock[] | undefined,
  terminalAnswer: string,
): ProcessingBlock[] {
  if (!terminalAnswer) return [...(blocks ?? [])];
  const next = [...(blocks ?? [])];
  const last = next[next.length - 1];
  if (last?.type !== 'thinking' || !last.content.endsWith(terminalAnswer)) {
    return next;
  }
  const content = last.content.slice(0, -terminalAnswer.length);
  if (!content) {
    next.pop();
    return next;
  }
  next[next.length - 1] = { ...last, content };
  return next;
}

/** upsert 工具块(对应 wework mergeProcessingBlock + finalize):
 *  先关闭打开的 thinking 块,再按 toolName 找已有 tool 块更新,否则新建。 */
export function upsertToolBlock(
  blocks: ProcessingBlock[] | undefined,
  toolName: string,
  patch: Partial<Omit<ToolBlock, 'id' | 'type' | 'toolName'>>,
): ProcessingBlock[] {
  const base = finalizeOpenThinkingBlocks(blocks ?? []);
  const next = [...base];
  const existingIndex = next.findIndex((b) => b.type === 'tool' && b.toolName === toolName);
  if (existingIndex >= 0 && next[existingIndex].type === 'tool') {
    const existing = next[existingIndex] as ToolBlock;
    // 已是 error/completed 终态时,不被后续 running/completed 覆盖:
    // 避免 tool_result(error) 后 output_item.done(completed) 把 error 一闪而过。
    // 只有新的 output 或 approval 事件可以更新已有终态块。
    const isTerminal = existing.status === 'error' || existing.status === 'completed';
    const patchHasOutput = patch.output !== undefined;
    const patchIsApproval = patch.extra && (patch.extra.approvalRequestId || patch.extra.approvalStatus);
    if (isTerminal && !patchHasOutput && !patchIsApproval) {
      return next;
    }
    // 合并时保留 existing.extra:tool_upsert 的 extra 通常是 undefined(不传审批),
    // 不能用它覆盖 approval_requested 写的 extra(否则审批卡流式时不显示,刷新才出)。
    const mergedExtra = patch.extra ?? existing.extra;
    next[existingIndex] = { ...existing, ...patch, extra: mergedExtra };
    return next;
  }
  return [
    ...next,
    {
      id: nextId('tool'),
      type: 'tool',
      toolName,
      args: patch.args ?? '',
      output: patch.output,
      status: patch.status ?? 'running',
      extra: patch.extra,
    },
  ];
}

/** 关闭最后一个 thinking 块(turn 结束/被工具打断后调用)。 */
export function finalizeThinkingBlocks(blocks: ProcessingBlock[] | undefined): ProcessingBlock[] {
  return finalizeOpenThinkingBlocks(blocks ?? []);
}

/** 取某 message 的有序 blocks(无则空数组,便于渲染层判空回退)。 */
export function getProcessingBlocks(blocks: ProcessingBlock[] | undefined): ProcessingBlock[] {
  return blocks ?? [];
}

/**
 * 从旧版历史字段(reasoning/tools/content)重建交错 blocks。
 * 新版 KsADK 会提供有序 Blocks 时间线；只有旧服务或旧会话缺少该时间线时
 * 才走这里的兼容回退，让历史消息仍走 ProcessingBlocksView。
 *
 * 顺序原因:ksadk 流式时思考在工具前、正文在工具后(appendTextBlock 先关 thinking)。
 * 旧记录无法还原多段思考被工具切断的真实交错,只能近似单段思考+工具+正文。
 */
export function buildBlocksFromHistory(input: {
  reasoning?: string;
  tools?: Record<string, { name: string; args?: string; output?: string; status?: string }>;
  content?: string;
}): ProcessingBlock[] {
  const blocks: ProcessingBlock[] = [];
  if (input.reasoning && input.reasoning.trim()) {
    blocks.push({ id: nextId('thinking'), type: 'thinking', content: input.reasoning, status: 'done' });
  }
  if (input.tools) {
    for (const tool of Object.values(input.tools)) {
      blocks.push({
        id: nextId('tool'),
        type: 'tool',
        toolName: tool.name,
        args: tool.args ?? '',
        output: tool.output,
        status: (tool.status as ToolBlock['status']) ?? 'completed',
      });
    }
  }
  if (input.content && input.content.trim()) {
    blocks.push({ id: nextId('text'), type: 'text', content: input.content, status: 'done' });
  }
  return blocks;
}
