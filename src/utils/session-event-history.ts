import { mergeSessionEventRecords } from './session-events.js';
import type { SessionEventRecord } from '../types/session-events.js';

export type ListSessionEventsPage = {
  Events?: unknown[];
  Total?: number;
  Offset?: number;
  Limit?: number;
};

export type ListSessionEventsFn = (
  sessionId: string,
  opts?: { offset?: number; limit?: number },
) => Promise<ListSessionEventsPage>;

export async function loadCompleteSessionEventHistory(
  sessionId: string,
  listSessionEvents: ListSessionEventsFn,
  options?: {
    pageSize?: number;
    shouldContinue?: () => boolean;
  },
): Promise<{
  events: SessionEventRecord[];
  total: number;
  offset: number;
  limit: number;
} | null> {
  const pageSize = Math.max(1, Number(options?.pageSize) || 50);
  const shouldContinue = options?.shouldContinue || (() => true);
  const shouldAbort = () => !shouldContinue();

  const probe = await listSessionEvents(sessionId, { offset: 0, limit: 1 });
  if (shouldAbort()) return null;

  const total = Math.max(0, Number(probe.Total ?? probe.Events?.length ?? 0) || 0);
  if (total <= 1) {
    return {
      events: ((probe.Events || []) as SessionEventRecord[]),
      total,
      offset: Number(probe.Offset ?? 0),
      limit: Number(probe.Limit ?? probe.Events?.length ?? 0),
    };
  }

  let nextOffset = Math.max(0, total - pageSize);
  const tail = await listSessionEvents(sessionId, {
    offset: nextOffset,
    limit: pageSize,
  });
  if (shouldAbort()) return null;

  let merged = (tail.Events || []) as SessionEventRecord[];

  while (nextOffset > 0) {
    const previousOffset = Math.max(0, nextOffset - pageSize);
    const previousLimit = nextOffset - previousOffset;
    const page = await listSessionEvents(sessionId, {
      offset: previousOffset,
      limit: previousLimit,
    });
    if (shouldAbort()) return null;
    merged = mergeSessionEventRecords(
      (page.Events || []) as SessionEventRecord[],
      merged,
    ) as SessionEventRecord[];
    nextOffset = previousOffset;
  }

  return {
    events: merged,
    total,
    offset: 0,
    limit: merged.length,
  };
}
