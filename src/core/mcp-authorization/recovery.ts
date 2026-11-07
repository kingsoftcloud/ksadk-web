import type { InteractionStore } from '../interaction/store.js';
import type { Interaction } from '../interaction/types.js';
import { isUserPendingInteraction } from '../interaction/pending.js';
import { authorizationInteraction } from './normalize.js';
import type { McpAuthorizationRequest } from './types.js';

/** Continue the card's status check while credential exchange hides it from the tray. */
export function observeMcpConnections(
  store: InteractionStore, sessionId: string, request: McpAuthorizationRequest,
  reloadHistory: (sessionId: string) => void,
) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;

  function stop(id: string) {
    clearTimeout(timers.get(id));
    timers.delete(id);
  }

  function track(row: Interaction) {
    if (row.sessionId !== sessionId || !row.runId) return;
    const runId = row.runId;
    const id = row.interactionId;
    if (row.status !== 'pending' || isUserPendingInteraction(row)) {
      stop(id);
      return;
    }
    if (timers.has(id)) return;
    async function poll() {
      try {
        const snapshot = await request('GetMcpAuthorizationWait', id, undefined, sessionId);
        if (disposed || !timers.has(id)) return;
        const next = authorizationInteraction(snapshot, sessionId, runId);
        const current = store.get(sessionId, id);
        if (next?.interactionId === id && current && next.revision > current.revision) {
          store.upsert(next);
          // The foreground stream may have ended on the old Pod. A newer
          // durable terminal snapshot can restore the original transcript.
          if (next.status === 'resolved' || next.status === 'cancelled' || next.status === 'expired') {
            reloadHistory(sessionId);
          }
        }
      } catch {
        // The same wait is still valid while its replacement Pod starts.
      }
      if (!disposed && timers.has(id)) timers.set(id, setTimeout(poll, 3000));
    }
    timers.set(id, setTimeout(poll, 3000));
  }

  store.listAll(sessionId).forEach(track);
  const unsubscribe = store.subscribe(event => {
    if (event.type === 'interaction_removed') stop(event.interactionId);
    else track(event.interaction);
  });
  return () => {
    disposed = true;
    unsubscribe();
    for (const id of timers.keys()) stop(id);
  };
}
