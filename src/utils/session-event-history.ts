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

// ---------------------------------------------------------------------------
// agent-kernel/v1 unified session cursor
// ---------------------------------------------------------------------------

import {
  decodeSessionEventEnvelope,
  type SessionEventEnvelope,
} from '../types/agent-control.js';

/** Two events sharing a seq but differing in content are a protocol error. */
export class SessionEventConflictError extends Error {
  seq: number;

  constructor(seq: number) {
    super(`Session event seq ${seq} was received twice with conflicting content`);
    this.name = 'SessionEventConflictError';
    this.seq = seq;
  }
}

function stableHash(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableHash).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableHash(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const DISPLAYABLE_FAMILIES = new Set(['runtime']);

/**
 * Deduplication/ordering state keyed strictly by the Session seq.
 *
 * Internal event ids from Responses/AG-UI/A2A projections are never used as a
 * reconnect cursor. Refresh replays are folded in before live events: an
 * exact duplicate seq is ignored, a conflicting one raises
 * {@link SessionEventConflictError}.
 */
export class SessionEventCursor {
  private eventsBySeq = new Map<number, SessionEventEnvelope>();
  private lastSeqValue = 0;

  /** Fold one raw kernel envelope into the cursor. */
  accept(raw: unknown): void {
    const decoded = decodeSessionEventEnvelope(raw);
    if (!decoded.ok) {
      throw decoded.error;
    }
    const incoming = decoded.value;
    const existing = this.eventsBySeq.get(incoming.seq);
    if (existing) {
      if (stableHash(existing) !== stableHash(incoming)) {
        throw new SessionEventConflictError(incoming.seq);
      }
      return;
    }
    this.eventsBySeq.set(incoming.seq, incoming);
    this.lastSeqValue = Math.max(this.lastSeqValue, incoming.seq);
  }

  get lastSeq(): number {
    return this.lastSeqValue;
  }

  /** Cursor value for SubscribeSessionEvents(after_seq) reconnects. */
  reconnectAfterSeq(): number {
    return this.lastSeqValue;
  }

  /** Events safe to project into the transcript, ordered by seq. */
  displayableEvents(): SessionEventEnvelope[] {
    return [...this.eventsBySeq.values()]
      .filter((event) => DISPLAYABLE_FAMILIES.has(event.family))
      .sort((a, b) => a.seq - b.seq);
  }
}

export function createSessionEventCursor(): SessionEventCursor {
  return new SessionEventCursor();
}
