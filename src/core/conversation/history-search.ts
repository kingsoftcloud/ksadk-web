import type { Message } from '../../components/chat/types.js';

export type HistorySearchMatch = { messageId: string; role: Message['role']; excerpt: string };
export type HistorySearchResult = {
  matches: HistorySearchMatch[];
  matchedMessages: number;
  searchedMessages: number;
  complete: boolean;
};
export type HistorySearchSnapshot = {
  owner: string;
  messages: Message[];
  hasMore: boolean;
  loading: boolean;
  checkpoint: string;
  error?: string;
};

/** Search readable projection data, including rows outside the virtual DOM.
 * Never index hidden reasoning or arbitrary protocol objects. */
export function searchConversationMessages(messages: Message[], query: string): HistorySearchResult {
  const needle = query.trim().toLocaleLowerCase();
  const matches: HistorySearchMatch[] = [];
  let matchedMessages = 0;
  for (const message of messages) {
    if (!needle) break;
    const texts = [message.content, ...(message.blocks || []).flatMap(block =>
      block.type === 'text' ? [block.content]
        : block.type === 'tool' ? [block.toolName, block.output || ''] : []),
    ...Object.values(message.tools || {}).flatMap(tool => [tool.name, tool.output || '']),
    ...(message.attachments || []).map(attachment => attachment.name)];
    for (const text of texts) {
      const index = text.toLocaleLowerCase().indexOf(needle);
      if (index < 0) continue;
      matchedMessages += 1;
      // Keep result UI bounded; all messages are still searched and counted.
      if (matches.length < 200) {
        const start = Math.max(0, index - 48);
        const end = Math.min(text.length, index + needle.length + 112);
        matches.push({ messageId: message.id, role: message.role,
          excerpt: `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}` });
      }
      break;
    }
  }
  return { matches, matchedMessages, searchedMessages: messages.length, complete: false };
}

/** Read existing history pages only. The owner and abort checks also guard
 * hosts whose transport resolves after cancellation. No execution is started. */
export async function scanConversationHistory(options: {
  query: string;
  snapshot: () => HistorySearchSnapshot;
  readOlder: (signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  onProgress?: (result: HistorySearchResult) => void;
}): Promise<HistorySearchResult> {
  const owner = options.snapshot().owner;
  const current = () => {
    options.signal.throwIfAborted();
    const snapshot = options.snapshot();
    if (snapshot.owner !== owner) throw new DOMException('Conversation changed', 'AbortError');
    return snapshot;
  };
  const yieldToInput = () => new Promise<void>(resolve => setTimeout(resolve, 16));
  while (true) {
    const before = current();
    if (before.loading) { await yieldToInput(); continue; }
    const result = searchConversationMessages(before.messages, options.query);
    result.complete = !before.hasMore && !before.error;
    options.onProgress?.(result);
    if (before.error) throw new Error(before.error);
    if (result.complete || !options.query.trim()) return result;
    const checkpoint = before.checkpoint;
    await options.readOlder(options.signal);
    const after = current();
    if (after.hasMore && after.checkpoint === checkpoint && !after.loading) {
      throw new Error('更早历史未返回新内容，请重试。当前结果只包含已加载的消息。');
    }
    await yieldToInput();
  }
}
