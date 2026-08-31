import type { Message } from '../components/chat/types.js';
import { buildBlocksFromHistory } from '../core/run/blocks.js';
import type { SessionEventRecord } from '../types/session-events.js';
import { buildMessagesFromSessionEvents } from './session-events.js';

export function mergeRecoveredRunMessages(
  messages: Message[],
  events: SessionEventRecord[],
  invocationId: string,
): Message[] {
  const existingOwned = messages.filter((message) => (
    message.role === 'model' && message.invocationId === invocationId
  ));
  const rawRecovered = (buildMessagesFromSessionEvents(events) as Message[])
    .filter((message) => message.role === 'model');
  const recovered = rawRecovered
    .map((message) => ({
      ...message,
      // Old SessionEvent producers have no RuntimeItem identity. Preserve the
      // existing row id for their single assistant projection so React does
      // not remount the message on every snapshot.
      id: !message.itemId && rawRecovered.length === 1
        ? existingOwned[0]?.id || `${invocationId}:assistant`
        : message.id,
      invocationId,
      blocks: buildBlocksFromHistory({
        content: message.content,
        reasoning: message.reasoning,
        tools: message.tools,
      }),
    }));
  if (recovered.length === 0) return messages;

  // Re-project the complete durable run snapshot on every event. This is the
  // same model used by Wework/VeADK: stable item identity owns rows; a terminal
  // snapshot replaces an item and never concatenates with the previous render.
  const firstOwnedIndex = messages.findIndex((message) => (
    message.role === 'model' && message.invocationId === invocationId
  ));
  const retained = messages.filter((message) => !(
    message.role === 'model' && message.invocationId === invocationId
  ));
  const insertionIndex = firstOwnedIndex < 0
    ? retained.length
    : Math.min(firstOwnedIndex, retained.length);
  return [
    ...retained.slice(0, insertionIndex),
    ...recovered,
    ...retained.slice(insertionIndex),
  ];
}
