import type { Message } from '../../components/chat/types.js';
import { mergeA2uiMessages } from './history.js';

type Activity = NonNullable<Message['aguiActivity']>;
type OwnerMessage = Pick<Message, 'id' | 'runId' | 'invocationId'>;
export type A2uiActivityOwner = { message: OwnerMessage; activity: Activity };

/** A surface id is local to its logical run, not a session-wide identity. */
export function sameA2uiActivityOwner(left: A2uiActivityOwner, right: A2uiActivityOwner): boolean {
  if (left.activity.surfaceId !== right.activity.surfaceId) return false;
  const leftInteraction = left.activity.interactionId;
  const rightInteraction = right.activity.interactionId;
  if (leftInteraction && rightInteraction) return leftInteraction === rightInteraction;
  const leftRun = left.activity.runId || left.message.runId || left.message.invocationId;
  const rightRun = right.activity.runId || right.message.runId || right.message.invocationId;
  if (leftRun && rightRun) return leftRun === rightRun;
  // Legacy events can still update their own message. Missing identity cannot
  // establish that another message belongs to the same business turn.
  return (left.activity.originMessageId || left.message.id)
    === (right.activity.originMessageId || right.message.id);
}

export function findA2uiActivityOwner<T extends A2uiActivityOwner>(owners: readonly T[], incoming: A2uiActivityOwner): T | undefined {
  const matches = owners.filter(owner => sameA2uiActivityOwner(owner, incoming));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Merge passive copies from AG-UI, canonical replay and legacy message history. */
export function coalesceA2uiActivities(messages: Message[]): Message[] {
  if (!messages.some(message => message.aguiActivity || message.aguiActivities?.length)) return messages;
  const owners = new Map<string, A2uiActivityOwner[]>();
  let duplicate = false;
  const result = messages.map(message => {
    const take = (activity: Activity): Activity | undefined => {
      const candidates = owners.get(activity.surfaceId) || [];
      const owner = findA2uiActivityOwner(candidates, { message, activity });
      if (owner) {
        const prior = owner.activity;
        duplicate = true;
        prior.messages = mergeA2uiMessages(prior.messages, activity.messages);
        prior.interactionId = activity.interactionId || prior.interactionId;
        prior.runId ||= activity.runId || message.runId || message.invocationId;
        prior.batchIds = [...new Set([...(prior.batchIds || []), ...(activity.batchIds || [])])];
        return undefined;
      }
      const runId = activity.runId || message.runId || message.invocationId;
      const copy = { ...activity, ...(runId ? { runId } : {}) };
      owners.set(activity.surfaceId, [...candidates, { message, activity: copy }]);
      return copy;
    };
    return {
      ...message,
      ...(message.aguiActivity ? { aguiActivity: take(message.aguiActivity) } : {}),
      ...(message.aguiActivities ? { aguiActivities: message.aguiActivities.flatMap(activity => {
        const kept = take(activity);
        return kept ? [kept] : [];
      }) } : {}),
    };
  });
  return duplicate ? result.filter(message => message.role !== 'a2ui' || message.aguiActivity
    || message.aguiActivities?.length || message.content) : messages;
}
