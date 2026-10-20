import type { ApiFacade } from '../core/api/types.js';
import type { SessionEventRecord } from '../types/session-events.js';
import { mergeSessionEventRecords } from './session-events.js';

type Page = Awaited<ReturnType<ApiFacade['listSessionEvents']>>;

/** Hydrate one visible remote run after the readable transcript has painted.
 * Older runs stay paginated; a warm switch displays its cache while refreshing.
 */
export async function hydrateKernelRunHistory(
  api: ApiFacade, sessionId: string, runId: string, initial: Page,
  isCurrent: () => boolean, signal?: AbortSignal,
): Promise<SessionEventRecord[]> {
  let events = initial.Events as SessionEventRecord[];
  if (events.some(e => e.EventType === 'run.started' && e.InvocationId === runId)) return events;
  const source = { cursorSource: initial.CursorSource, historyEpoch: initial.HistoryEpoch,
    snapshotSeqId: initial.SnapshotSeqId, signal };
  const sameSnapshot = (page: Page) => {
    if (page.CursorSource !== initial.CursorSource || page.HistoryEpoch !== initial.HistoryEpoch
      || page.SnapshotSeqId !== initial.SnapshotSeqId) throw new Error('Kernel run history snapshot changed');
  };
  let startSeq = 0;
  let before: number | undefined;
  while (isCurrent() && !signal?.aborted) {
    const page = await api.listSessionEvents(sessionId, { ...source, eventTypes: ['run.started'], limit: 64, beforeSeqId: before });
    sameSnapshot(page);
    const starts = page.Events as SessionEventRecord[];
    const start = starts.find(e => e.EventType === 'run.started' && e.InvocationId === runId);
    if (start) { startSeq = Number(start.SeqId); break; }
    if (!page.HasMore) return events;
    const next = Math.min(...starts.map(e => Number(e.SeqId)));
    if (!Number.isSafeInteger(next) || next <= 0 || (before !== undefined && next >= before)) throw new Error('Kernel run metadata cursor did not advance');
    before = next;
  }
  if (!Number.isSafeInteger(startSeq) || startSeq <= 0) return events;
  while (isCurrent() && !signal?.aborted && events.length) {
    const oldest = Math.min(...events.map(e => Number(e.SeqId)));
    if (oldest <= startSeq) break;
    const page = await api.listSessionEvents(sessionId, { ...source, limit: 64, beforeSeqId: oldest, afterSeqId: startSeq - 1 });
    sameSnapshot(page);
    const older = page.Events as SessionEventRecord[];
    if (!older.length || older.some(e => !Number.isSafeInteger(e.SeqId) || Number(e.SeqId) >= oldest || Number(e.SeqId) < startSeq)) throw new Error('Kernel run history cursor did not advance');
    events = mergeSessionEventRecords(events, older);
  }
  return events;
}
