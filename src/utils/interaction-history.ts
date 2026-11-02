import type { Message } from '../components/chat/types.js';
import type { ApiFacade } from '../core/api/types.js';
import { interactionFromSessionEvent } from '../core/interaction/adapters/session-events.js';
import type { SessionEventRecord } from '../types/session-events.js';

type Page = Awaited<ReturnType<ApiFacade['listSessionEvents']>>;
const REQUESTED_TYPES = ['interaction.requested', 'interaction_requested',
  'ksadk.interaction/v1.requested', 'InteractionRequested', 'approval.requested', 'a2ui.interaction'];
const EVENT_TYPES = [...REQUESTED_TYPES, 'interaction.resolved', 'interaction_resolved',
  'ksadk.interaction/v1.resolved', 'InteractionResolved', 'interaction.cancelled',
  'interaction.cancel', 'interaction.expired', 'approval.resolved', 'a2ui.action'];
const PAGE_SIZE = 32;
const MAX_PAGES = 2;

/** Recover only visible interaction metadata; never expand the transcript event cursor. */
export async function hydrateVisibleInteractionHistory(
  api: ApiFacade, sessionId: string, messages: readonly Message[], initial: Page,
  isCurrent: () => boolean, signal?: AbortSignal,
): Promise<{ events: SessionEventRecord[]; incomplete: boolean }> {
  const targets = new Set<string>();
  let after = Infinity;
  const collect = (rows: readonly Message[]) => {
    for (const message of rows) {
      if (message.agentBlock) collect(message.agentBlock.messages);
      const ids = [message.a2ui?.pendingInteraction?.interactionId,
        message.aguiActivity?.interactionId,
        ...(message.aguiActivities || []).map(activity => activity.interactionId),
        ...Object.values(message.tools || {}).map(tool => tool.approvalRequestId),
        ...(message.blocks || []).map(block => block.type === 'tool' ? block.extra?.approvalRequestId : undefined),
      ].filter((id): id is string => typeof id === 'string' && id.length > 0);
      if (!ids.length) continue;
      ids.forEach(id => targets.add(id));
      const seq = message.historyOrder?.group ?? message.historyOrder?.seq;
      if (Number.isSafeInteger(seq) && Number(seq) > 0) after = Math.min(after, Number(seq) - 1);
    }
  };
  collect(messages);
  // Old servers retain their existing approval fallback. A bounded read must
  // have a stable runtime snapshot and a loaded-message range to stay within.
  if (!targets.size || !Number.isFinite(after) || initial.CursorSource !== 'runtime'
    || !initial.HistoryEpoch || !Number.isSafeInteger(initial.SnapshotSeqId)) {
    return { events: [], incomplete: false };
  }
  const requested = new Set<string>();
  const accept = (event: SessionEventRecord) => {
    const interaction = interactionFromSessionEvent(event, sessionId);
    if (!interaction || !targets.has(interaction.interactionId)) return false;
    if (interaction.status === 'pending') requested.add(interaction.interactionId);
    return true;
  };
  (initial.Events as SessionEventRecord[]).forEach(accept);
  if ([...targets].every(id => requested.has(id))) return { events: [], incomplete: false };
  const events: SessionEventRecord[] = [];
  let before = Number(initial.SnapshotSeqId) + 1;
  for (let pageIndex = 0; pageIndex < MAX_PAGES && isCurrent() && !signal?.aborted; pageIndex += 1) {
    const page = await api.listSessionEvents(sessionId, {
      eventTypes: EVENT_TYPES, limit: PAGE_SIZE, afterSeqId: after, beforeSeqId: before,
      cursorSource: initial.CursorSource, historyEpoch: initial.HistoryEpoch,
      snapshotSeqId: initial.SnapshotSeqId, signal,
    });
    if (!isCurrent() || signal?.aborted) return { events: [], incomplete: true };
    if (page.CursorSource !== initial.CursorSource || page.HistoryEpoch !== initial.HistoryEpoch
      || page.SnapshotSeqId !== initial.SnapshotSeqId) throw new Error('Interaction history snapshot changed');
    const rows = page.Events as SessionEventRecord[];
    for (const row of rows) if (accept(row)) events.push(row);
    if (!page.HasMore || [...targets].every(id => requested.has(id))) {
      return { events, incomplete: [...targets].some(id => !requested.has(id)) };
    }
    const next = Math.min(...rows.map(row => Number(row.SeqId)));
    if (!Number.isSafeInteger(next) || next <= after || next >= before) {
      throw new Error('Interaction history cursor did not advance');
    }
    before = next;
  }
  return { events, incomplete: true };
}
