import { artifactSchema, decodeGroupEvent, decodeGroupSnapshot, deliverySchema, groupSchema, interactionSchema, memberSchema, messageSchema, taskSchema, teamRunSchema, TeamsError } from './contracts.js';
import type { GroupEvent, GroupSnapshot, InteractionRef, MemberStreamRef } from './types.js';

export function memberStreamKey(ref: MemberStreamRef): string {
  return JSON.stringify([ref.authorityRef, ref.groupId, ref.memberId, ref.bindingRef, ref.providerRef, ref.sessionId, ref.runId]);
}
export function interactionRefKey(ref: InteractionRef): string {
  return JSON.stringify([memberStreamKey(ref), ref.interactionId]);
}

function upsert<T extends { revision: number }>(rows: T[], row: T, key: (row: T) => string): T[] {
  const index = rows.findIndex(value => key(value) === key(row));
  if (index >= 0 && rows[index].revision >= row.revision) return rows;
  return index < 0 ? [...rows, row] : rows.map((value, position) => position === index ? row : value);
}

/** One reducer per authorized group. It never mutates source ConversationItems. */
export class GroupReducer {
  private value: GroupSnapshot;
  private seenIds = new Set<string>();
  constructor(snapshot: GroupSnapshot) { this.value = decodeGroupSnapshot(snapshot); }
  snapshot(): GroupSnapshot { return this.value; }
  replace(raw: unknown): boolean {
    const snapshot = decodeGroupSnapshot(raw);
    if (snapshot.group.groupId !== this.value.group.groupId || snapshot.group.authorityRef !== this.value.group.authorityRef || snapshot.group.tenantId !== this.value.group.tenantId) throw new TeamsError('scope_mismatch', '不能把另一个群或授权域的快照用于当前会话。');
    if (snapshot.watermark < this.value.watermark || snapshot.group.revision < this.value.group.revision) return false;
    this.value = snapshot;
    this.seenIds.clear();
    return true;
  }
  apply(raw: GroupEvent): boolean {
    const event = decodeGroupEvent(raw);
    const previous = this.value;
    if (event.groupId !== previous.group.groupId) throw new TeamsError('scope_mismatch', '事件不属于当前群。');
    if (event.groupSeq <= previous.watermark) return false;
    if (event.groupSeq !== previous.watermark + 1 || this.seenIds.has(event.eventId)) throw new TeamsError('reset_required', '群事件存在缺口，需要重新读取快照。');
    const next = { ...previous, watermark: event.groupSeq };
    const decode = <T,>(schema: { parse(raw: unknown): T }, raw: unknown): T => {
      let row: T;
      try { row = schema.parse(raw); } catch { throw new TeamsError('contract_mismatch', '群事件内容格式不兼容。'); }
      const scoped = row as { groupId?: string; ref?: InteractionRef; source?: MemberStreamRef; sourceRefs?: MemberStreamRef[]; attempts?: { source?: MemberStreamRef; artifacts: { source: MemberStreamRef }[] }[] };
      if ((scoped.groupId && scoped.groupId !== previous.group.groupId) || (scoped.ref && (scoped.ref.groupId !== previous.group.groupId || scoped.ref.authorityRef !== previous.group.authorityRef))) throw new TeamsError('scope_mismatch', '群事件引用了其他作用域。');
      const sources = [...(scoped.source ? [scoped.source] : []), ...(scoped.sourceRefs || []), ...(scoped.attempts || []).flatMap(attempt => [...(attempt.source ? [attempt.source] : []), ...attempt.artifacts.map(artifact => artifact.source)])];
      if (sources.some(ref => ref.groupId !== previous.group.groupId || ref.authorityRef !== previous.group.authorityRef)) throw new TeamsError('scope_mismatch', '群事件的产物或执行来源跨越作用域。');
      return row;
    };
    switch (event.type) {
      case 'group.updated': {
        const row = decode(groupSchema, event.payload.group) as GroupSnapshot['group'];
        if (row.groupId !== previous.group.groupId || row.authorityRef !== previous.group.authorityRef || row.tenantId !== previous.group.tenantId) throw new TeamsError('scope_mismatch', '群事件改变了授权域。');
        if (row.revision > previous.group.revision) next.group = row;
        break;
      }
      case 'member.updated': next.members = upsert(previous.members, decode(memberSchema, event.payload.member) as GroupSnapshot['members'][number], row => row.memberId); break;
      case 'message.created':
      case 'message.updated': next.messages = upsert(previous.messages, decode(messageSchema, event.payload.message) as GroupSnapshot['messages'][number], row => row.messageId); break;
      case 'task.updated': next.tasks = upsert(previous.tasks, decode(taskSchema, event.payload.task) as GroupSnapshot['tasks'][number], row => row.taskId); break;
      case 'team_run.updated': next.teamRuns = upsert(previous.teamRuns, decode(teamRunSchema, event.payload.teamRun) as GroupSnapshot['teamRuns'][number], row => row.teamRunId); break;
      case 'delivery.updated': next.deliveries = upsert(previous.deliveries, decode(deliverySchema, event.payload.delivery) as GroupSnapshot['deliveries'][number], row => row.deliveryId); break;
      case 'artifact.updated': {
        const row = decode(artifactSchema, event.payload.artifact);
        next.artifacts = [...new Map([...(previous.artifacts || []), row].map(artifact => [artifact.artifactId, artifact])).values()];
        break;
      }
      case 'interaction.updated': next.interactions = upsert(previous.interactions, decode(interactionSchema, event.payload.interaction) as GroupSnapshot['interactions'][number], row => interactionRefKey(row.ref)); break;
      // Forward-compatible events advance the durable cursor, never execute payloads.
      default: break;
    }
    this.seenIds.add(event.eventId);
    if (this.seenIds.size > 2048) this.seenIds.delete(this.seenIds.values().next().value!);
    this.value = next;
    return true;
  }
}
