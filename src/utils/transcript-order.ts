import type { Message } from '../components/chat/types.js';
import { coalesceA2uiActivities } from '../core/a2ui/transcript.js';
import { coalesceHistoryToolCalls } from './history-tool-facts.js';

const runOf = (message: Message) => message.runId || message.invocationId;

/** Sort sequenced rows without turning clocks into log positions. Legacy rows
 * lacking a sequence stay attached to their nearest received neighbour. When
 * no sequence is available, the endpoint's existing order is authoritative. */
export function orderTranscript(messages: Message[]): Message[] {
  const groups = new Map<string, number>();
  for (const message of messages) {
    const run = runOf(message), group = message.historyOrder?.group;
    if (run && group !== undefined) groups.set(run, Math.min(group, groups.get(run) ?? group));
  }
  const positions = messages.map((message, index) => ({ message, index,
    seq: message.historyOrder?.seq,
    group: message.historyOrder?.group ?? groups.get(runOf(message) || '') ?? message.historyOrder?.seq,
    part: message.historyOrder?.index || 0 }));
  let next: number | undefined;
  const following = positions.map(() => undefined as number | undefined);
  for (let i = positions.length - 1; i >= 0; i--) {
    following[i] = next;
    if (positions[i].group !== undefined) next = positions[i].group;
  }
  let previous: number | undefined;
  const keyed = positions.map(row => {
    if (row.group !== undefined) {
      previous = row.group;
      return { ...row, anchor: row.group, side: 0 };
    }
    return { ...row, anchor: previous ?? following[row.index] ?? 0,
      side: previous === undefined && following[row.index] !== undefined ? -1 : 1 };
  });
  return keyed.sort((a, b) => a.anchor - b.anchor || a.side - b.side
    || (a.side === 0 ? (a.seq ?? a.anchor) - (b.seq ?? b.anchor) : 0)
    || (a.side === 0 ? a.part - b.part : 0) || a.index - b.index).map(row => row.message);
}

function contentChanged(message: Message, previous?: Message): boolean {
  if (!previous) return true;
  const changed = (key: keyof Message) => {
    if (key === 'feedback') return false;
    if (key === 'historyOrder') {
      return message.historyOrder?.seq !== previous.historyOrder?.seq
        || message.historyOrder?.index !== previous.historyOrder?.index
        || message.historyOrder?.group !== previous.historyOrder?.group;
    }
    return message[key] !== previous[key];
  };
  return (Object.keys(message) as (keyof Message)[]).some(changed)
    || (Object.keys(previous) as (keyof Message)[]).some(changed);
}

/** An in-flight page must not roll a live run back to its older snapshot.
 * Feedback updates are presentation changes, not new runtime content. Keep
 * them without replacing the run's newly hydrated historical items. */
export function mergeHistoryWithLive(
  history: Message[], baseline: Message[], current: Message[],
): Message[] {
  const before = new Map(baseline.map(message => [message.id, message]));
  const feedback = current.filter(message => before.has(message.id)
    && before.get(message.id)?.feedback !== message.feedback);
  const feedbackById = new Map(feedback.map(message => [message.id, message.feedback]));
  const feedbackKey = (message: Message) => JSON.stringify([runOf(message), message.responseId]);
  const feedbackByResponse = new Map(feedback.filter(message => message.responseId)
    .map(message => [feedbackKey(message), message.feedback]));
  const withFeedback = (messages: Message[]) => messages.map(message => {
    if (feedbackById.has(message.id)) return { ...message, feedback: feedbackById.get(message.id) };
    const key = feedbackKey(message);
    return message.responseId && feedbackByResponse.has(key)
      ? { ...message, feedback: feedbackByResponse.get(key) } : message;
  });
  const changed = current.filter(message => contentChanged(message, before.get(message.id)));
  if (!changed.length) return coalesceA2uiActivities(coalesceHistoryToolCalls(withFeedback(history)));
  const changedRuns = new Set(changed.map(runOf).filter(Boolean));
  const changedIds = new Set(changed.map(message => message.id));
  const live = current.filter(message => changedRuns.has(runOf(message)) || changedIds.has(message.id));
  // Keep a durable input when the live projection only contains output. Each
  // changed run occupies its existing historical position, not the list tail.
  let result = history;
  for (const runId of changedRuns) {
    const run = live.filter(message => runOf(message) === runId);
    const original = history.filter(message => runOf(message) === runId);
    const first = result.findIndex(message => runOf(message) === runId);
    const input = run.some(message => message.role === 'user') ? []
      : original.filter(message => message.role === 'user');
    result = result.filter(message => runOf(message) !== runId);
    const insertion = first < 0 ? result.length : Math.min(first, result.length);
    result.splice(insertion, 0, ...input, ...run.map(message => ({ ...message,
      historyOrder: message.historyOrder || original.find(row => row.id === message.id)?.historyOrder,
    })));
  }
  // Rows without a run identity (e.g. optimistic inputs) retain arrival order.
  for (const message of live.filter(message => !runOf(message))) {
    const index = result.findIndex(row => row.id === message.id);
    if (index < 0) {
      // A just-submitted user input may not have its invocation ID yet. Its
      // live assistant already does; appending the input at the end would
      // render the answer before the question when an older page resolves.
      const position = current.indexOf(message);
      const following = current.slice(position + 1).find(row => result.some(item => item.id === row.id));
      const preceding = current.slice(0, position).findLast(row => result.some(item => item.id === row.id));
      const insertion = following ? result.findIndex(row => row.id === following.id)
        : preceding ? result.findIndex(row => row.id === preceding.id) + 1 : result.length;
      result = [...result.slice(0, insertion), message, ...result.slice(insertion)];
    }
    else result = result.map((row, i) => i === index
      ? { ...message, historyOrder: message.historyOrder || row.historyOrder } : row);
  }
  return coalesceA2uiActivities(coalesceHistoryToolCalls(withFeedback(orderTranscript(result))));
}
