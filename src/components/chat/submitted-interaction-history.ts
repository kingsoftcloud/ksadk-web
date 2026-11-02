import { validatedApprovalA2ui } from '../../core/interaction/a2ui-validate.js';
import type { Interaction } from '../../core/interaction/types.js';
import { submittedResponse } from '../../core/interaction/response-snapshot.js';
import type { Message } from './types.js';
import { defaultA2uiCatalogRegistry, type A2uiCatalogRegistry } from '../../core/a2ui/registry.js';
import { a2uiSurfaceSnapshot } from '../../core/a2ui/snapshot.js';

export type MissingSubmittedInputHistory = {
  interaction: Interaction;
  anchor: boolean;
  surfaceIds: string[];
};

function presentationSurfaces(interaction: Interaction): string[] {
  const active = new Set<string>();
  for (const message of interaction.presentation?.a2ui?.messages || []) {
    const create = message.createSurface as { surfaceId?: string } | undefined;
    const remove = message.deleteSurface as { surfaceId?: string } | undefined;
    if (remove?.surfaceId) active.delete(remove.surfaceId);
    if (create?.surfaceId) active.add(create.surfaceId);
  }
  return [...active];
}

/** Missing transport ids may be recovered only from one same-run presentation. */
export function interactionForA2uiActivity(
  activity: { surfaceId: string; interactionId?: string }, message: Message,
  interactions: readonly Interaction[] = [],
): Interaction | undefined {
  if (activity.interactionId) return interactions.find(entry => entry.interactionId === activity.interactionId);
  const candidates = interactions.filter(entry => entry.runId
    && (entry.runId === message.runId || entry.runId === message.invocationId)
    && presentationSurfaces(entry).includes(activity.surfaceId));
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Attach unprojected metadata to its loaded run, independently of virtualization. */
export function missingSubmittedInputHistory(
  messages: readonly Message[], interactions: readonly Interaction[] = [],
  registry: A2uiCatalogRegistry = defaultA2uiCatalogRegistry,
): ReadonlyMap<string, MissingSubmittedInputHistory[]> {
  const anchors = new Set<string>();
  const surfaces = new Set<string>();
  const runSurfaces = new Set<string>();
  for (const message of messages) {
    const activities = [...(message.aguiActivities || []), ...(message.aguiActivity ? [message.aguiActivity] : [])];
    for (const activity of activities) {
      if (activity.interactionId) surfaces.add(`${activity.interactionId}\0${activity.surfaceId}`);
      for (const runId of [message.runId, message.invocationId]) {
        if (runId) runSurfaces.add(`${runId}\0${activity.surfaceId}`);
      }
    }
    if (message.agentBlock) continue;
    const tools = Object.values(message.tools || {});
    if (message.blocks?.length) {
      for (const block of message.blocks) {
        if (block.type !== 'tool') continue;
        const extra = block.extra || {};
        const tool = message.tools?.[block.toolName] || tools.find(entry =>
          (extra.approvalRequestId && entry.approvalRequestId === extra.approvalRequestId)
          || (extra.callId && entry.callId === extra.callId));
        const id = extra.approvalRequestId || tool?.approvalRequestId;
        if (typeof id === 'string' && id) anchors.add(id);
        else {
          const callId = String(extra.callId || extra.call_id || '');
          const record = callId && interactions.find(entry => entry.extensions.call_id === callId);
          if (record) anchors.add(record.interactionId);
        }
      }
    } else for (const tool of tools) if (tool.approvalRequestId) anchors.add(tool.approvalRequestId);
  }
  const byMessage = new Map<string, MissingSubmittedInputHistory[]>();
  const seen = new Set<string>();
  for (const interaction of interactions) {
    const approvalHistory = ['resolved', 'expired'].includes(interaction.status) && validatedApprovalA2ui(interaction, registry);
    if (!interaction.runId || (!submittedResponse(interaction) && !approvalHistory) || seen.has(interaction.interactionId)) continue;
    seen.add(interaction.interactionId);
    const anchor = !anchors.has(interaction.interactionId);
    const surfaceIds = approvalHistory ? [] : presentationSurfaces(interaction).filter(id => {
      const represented = surfaces.has(`${interaction.interactionId}\0${id}`) || runSurfaces.has(`${interaction.runId}\0${id}`);
      if (!represented) return true;
      const original = a2uiSurfaceSnapshot(id, interaction.presentation!.a2ui!.messages, registry);
      if (original === undefined) return false;
      const snapshots = messages.flatMap(message => {
        const sameRun = message.runId === interaction.runId || message.invocationId === interaction.runId;
        return [...(message.aguiActivities || []), ...(message.aguiActivity ? [message.aguiActivity] : [])]
          .filter(activity => activity.surfaceId === id && (activity.interactionId === interaction.interactionId
            || !activity.interactionId && sameRun))
          .map(activity => a2uiSurfaceSnapshot(id, activity.messages, registry));
      });
      // An updated result is not the original input history. Incomplete old
      // activity records retain the conservative legacy duplicate guard.
      return snapshots.length > 0 && snapshots.every(snapshot => snapshot !== undefined && snapshot !== original);
    });
    if (!anchor && !surfaceIds.length) continue;
    const candidates = messages.filter(message => (message.runId === interaction.runId
      || message.invocationId === interaction.runId) && !message.agentBlock
      && message.eventType !== 'optimistic_assistant_placeholder'
      && (message.role === 'model' || message.role === 'user' || (approvalHistory && message.role === 'a2ui')));
    const withText = candidates.filter(message => message.role === 'model' && message.content.trim());
    const assistants = candidates.filter(message => message.role === 'model');
    const ordinary = candidates.filter(message => message.role !== 'a2ui');
    const preferred = withText.length ? withText : assistants.length ? assistants : ordinary.length ? ordinary : candidates;
    const owner = preferred.reduce<Message | undefined>((latest, message) => {
      if (!latest) return message;
      const seq = message.historyOrder?.seq;
      const lastSeq = latest.historyOrder?.seq;
      if (seq !== undefined && lastSeq !== undefined && seq !== lastSeq) return seq > lastSeq ? message : latest;
      return message.timestamp >= latest.timestamp ? message : latest;
    }, undefined);
    if (!owner) continue;
    byMessage.set(owner.id, [...(byMessage.get(owner.id) || []), { interaction, anchor, surfaceIds }]);
  }
  return byMessage;
}
