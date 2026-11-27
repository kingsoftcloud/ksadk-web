import type { SessionMessageHistory } from '../stores/session.js';

// A background read must be tied to the same immutable source as the active
// transcript. Older unpinned control responses remain demand-driven.
export function prefetchHistoryCursor(history?: SessionMessageHistory): string | number | null {
  if (!history?.hasMore || history.retryOlderPage) return null;
  if (history.historyView === 'items-v1') return history.nextItemCursor ?? null;
  if (history.cursorSource === 'runtime' && history.historyEpoch && history.snapshotSeqId !== undefined) {
    return history.nextCursor;
  }
  return null;
}

export function ownsOlderMessageScrollRequest(options: {
  requestedSessionId: string;
  activeSessionId: string | null;
  requestToken: symbol;
  activeRequestToken: symbol | null;
}): boolean {
  return options.requestedSessionId === options.activeSessionId
    && options.requestToken === options.activeRequestToken;
}
