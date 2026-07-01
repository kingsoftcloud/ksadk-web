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

export function resolveOlderSessionEventPage(
  cache: { offset: number; total: number },
  pageSize: number,
): { offset: number; limit: number } | null {
  const offset = Math.max(0, Number(cache.offset) || 0);
  const total = Math.max(0, Number(cache.total) || 0);
  if (offset >= total) {
    return null;
  }
  return {
    offset,
    limit: Math.min(Math.max(1, Number(pageSize) || 1), total - offset),
  };
}

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

  const tailPage = resolveOlderSessionEventPage({ offset: 0, total }, pageSize);
  if (!tailPage) {
    return {
      events: [],
      total,
      offset: 0,
      limit: 0,
    };
  }
  const tail = await listSessionEvents(sessionId, tailPage);
  if (shouldAbort()) return null;

  let merged = (tail.Events || []) as SessionEventRecord[];
  let loadedCount = merged.length;

  while (loadedCount < total) {
    const nextPage = resolveOlderSessionEventPage(
      { offset: loadedCount, total },
      pageSize,
    );
    if (!nextPage) break;
    const page = await listSessionEvents(sessionId, nextPage);
    if (shouldAbort()) return null;
    merged = mergeSessionEventRecords(
      (page.Events || []) as SessionEventRecord[],
      merged,
    ) as SessionEventRecord[];
    loadedCount += (page.Events || []).length;
  }

  return {
    events: merged,
    total,
    offset: loadedCount,
    limit: merged.length,
  };
}
