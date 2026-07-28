import type { Message } from '../components/chat/types.js';
import { buildBlocksFromHistory } from '../core/run/blocks.js';
import type { SessionEventRecord } from '../types/session-events.js';
import { buildMessagesFromSessionEvents } from './session-events.js';

function mergeRecoveredText(existing: string | undefined, recovered: string | undefined): string {
  const previous = String(existing || '');
  const next = String(recovered || '');
  if (!previous || !next || previous.endsWith(next)) return previous || next;
  if (next.startsWith(previous)) return next;
  return `${previous}${next}`;
}

function mergeRecoveredTools(
  existing: Message['tools'] | undefined,
  recovered: Message['tools'] | undefined,
): Message['tools'] | undefined {
  if (!existing) return recovered;
  if (!recovered) return existing;
  return Object.fromEntries(
    [...new Set([...Object.keys(existing), ...Object.keys(recovered)])].map((key) => [
      key,
      { ...(existing[key] || {}), ...(recovered[key] || {}) },
    ]),
  ) as Message['tools'];
}

export function mergeRecoveredRunMessages(
  messages: Message[],
  events: SessionEventRecord[],
  invocationId: string,
): Message[] {
  const recovered = (buildMessagesFromSessionEvents(events) as Message[])
    .filter((message) => message.role === 'model')
    .at(-1);
  if (!recovered) return messages;

  const existingIndex = messages.findIndex((message) =>
    message.role === 'model' && message.invocationId === invocationId,
  );
  const existing = existingIndex >= 0 ? messages[existingIndex] : undefined;
  const content = mergeRecoveredText(existing?.content, recovered.content);
  const reasoning = mergeRecoveredText(existing?.reasoning, recovered.reasoning);
  const tools = mergeRecoveredTools(existing?.tools, recovered.tools);
  const merged: Message = {
    ...existing,
    ...recovered,
    id: existing?.id || recovered.id || `${invocationId}:assistant`,
    invocationId,
    content,
    reasoning,
    tools,
    blocks: buildBlocksFromHistory({ content, reasoning, tools }),
  };

  if (existingIndex < 0) {
    return [...messages, merged];
  }
  return messages.map((message, index) => (index === existingIndex ? merged : message));
}
