import { ApiError } from '../api/client.js';
import type { ApiFacade } from '../core/api/types.js';

type HistoryPage = Awaited<ReturnType<ApiFacade['listSessionMessages']>>;
type Scope = Pick<HistoryPage, 'HistoryEpoch' | 'SnapshotSeqId' | 'CursorSource'>;

export interface HistoryContentCheckpoint {
  partial?: { api: ApiFacade; key: string; chunks: string[]; offset: number };
}
export type ReadHistoryContent = (signal: AbortSignal, checkpoint?: HistoryContentCheckpoint) => Promise<string>;

function waitForRetry(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

/** Keep validated chunks only for the lifetime of this expanded item. */
export async function readItemJson(api: ApiFacade, sessionId: string, seq: number, scope: Scope,
  signal: AbortSignal, checkpoint: HistoryContentCheckpoint = {}, contentPart?: 'inbox'): Promise<unknown> {
  const key = JSON.stringify([sessionId, scope.HistoryEpoch, scope.SnapshotSeqId, scope.CursorSource, seq, contentPart]);
  if (checkpoint.partial?.key !== key || checkpoint.partial.api !== api) {
    checkpoint.partial = { api, key, chunks: [], offset: 0 };
  }
  const partial = checkpoint.partial;
  try {
    let retries = 0;
    while (true) {
      signal.throwIfAborted();
      let page: HistoryPage;
      try {
        page = await api.listSessionMessages(sessionId, { historyView: 'items-v1', contentSeqId: seq,
          contentOffset: partial.offset, contentPart, cursorSource: scope.CursorSource, historyEpoch: scope.HistoryEpoch,
          snapshotSeqId: scope.SnapshotSeqId, signal });
      } catch (error) {
        if (error instanceof ApiError && error.code === 429 && retries < 3) {
          const delay = error.retryAfterMs ?? (500 * 2 ** retries);
          if (delay <= 8000) {
            retries++;
            await waitForRetry(delay, signal);
            continue;
          }
        }
        if (error instanceof ApiError && [400, 401, 403, 404, 409, 410, 422].includes(error.code)) {
          delete checkpoint.partial;
        }
        throw error;
      }
      signal.throwIfAborted();
      if (page.HistoryView !== 'items-v1' || page.HistoryEpoch !== scope.HistoryEpoch
        || page.SnapshotSeqId !== scope.SnapshotSeqId || page.ContentSeqId !== seq || typeof page.ContentChunk !== 'string') {
        delete checkpoint.partial;
        throw new Error('历史正文快照已变化，请重新打开会话。');
      }
      if (page.NextContentOffset === null) {
        delete checkpoint.partial;
        partial.chunks.push(page.ContentChunk);
        return JSON.parse(partial.chunks.join(''));
      }
      if (!page.ContentChunk.length || !Number.isSafeInteger(page.NextContentOffset) || page.NextContentOffset! <= partial.offset) {
        delete checkpoint.partial;
        throw new Error('历史正文游标无效。');
      }
      partial.chunks.push(page.ContentChunk);
      partial.offset = page.NextContentOffset!;
      retries = 0;
    }
  } finally {
    if (signal.aborted && checkpoint.partial === partial) delete checkpoint.partial;
  }
}
