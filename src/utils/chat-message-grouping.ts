import type { Message } from '../components/chat/types.js';

function turnId(message: Message | undefined): string {
  return String(message?.runId || message?.invocationId || '').trim();
}

/** Whether a model row is another activity from the preceding assistant turn. */
export function continuesAssistantTurn(
  previous: Message | undefined,
  current: Message,
): boolean {
  if (previous?.role !== 'model' || current.role !== 'model') return false;
  const previousTurnId = turnId(previous);
  return Boolean(previousTurnId && previousTurnId === turnId(current));
}
