type Operation = Record<string, unknown>;

/** Legacy full snapshots and new immutable operation batches share one history. */
export function mergeA2uiMessages(previous: Operation[], incoming: Operation[]): Operation[] {
  const left = previous.map(message => JSON.stringify(message));
  const right = incoming.map(message => JSON.stringify(message));
  if (left.every((message, index) => right[index] === message)) return incoming;
  if (right.every((message, index) => left[index] === message)) return previous;
  return [...previous, ...incoming];
}

export function mergeA2uiActivity<T extends {
  surfaceId: string; messages: Operation[]; batchIds?: string[];
  runId?: string; interactionId?: string; originMessageId?: string;
}>(
  previous: T | undefined,
  incoming: T,
  batchId?: string,
): T {
  const identity = {
    ...(incoming.runId || previous?.runId ? { runId: incoming.runId || previous?.runId } : {}),
    ...(incoming.interactionId || previous?.interactionId
      ? { interactionId: incoming.interactionId || previous?.interactionId } : {}),
    ...(previous?.originMessageId || incoming.originMessageId
      ? { originMessageId: previous?.originMessageId || incoming.originMessageId } : {}),
  };
  if (batchId && previous?.batchIds?.includes(batchId)) {
    // A duplicate body can still promote a tool card into a native input wait.
    return Object.entries(identity).every(([key, value]) => previous[key as keyof T] === value)
      ? previous : { ...previous, ...identity };
  }
  return {
    ...incoming,
    ...identity,
    messages: previous ? mergeA2uiMessages(previous.messages, incoming.messages) : incoming.messages,
    ...(batchId || previous?.batchIds || incoming.batchIds ? {
      batchIds: [...new Set([...(previous?.batchIds || []), ...(incoming.batchIds || []), ...(batchId ? [batchId] : [])])],
    } : {}),
  };
}
