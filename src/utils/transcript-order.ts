import type { Message } from '../components/chat/types.js';

const runOf = (message: Message) => message.runId || message.invocationId;

/** Sort sequenced rows without turning clocks into log positions. Legacy rows
 * lacking a sequence stay attached to their nearest received neighbour. When
 * no sequence is available, the endpoint's existing order is authoritative. */
export function orderTranscript(messages: Message[]): Message[] {
  const positions = messages.map((message, index) => ({ message, index,
    seq: message.historyOrder?.seq, part: message.historyOrder?.index || 0 }));
  let next: number | undefined;
  const following = positions.map(() => undefined as number | undefined);
  for (let i = positions.length - 1; i >= 0; i--) {
    following[i] = next;
    if (positions[i].seq !== undefined) next = positions[i].seq;
  }
  let previous: number | undefined;
  const keyed = positions.map(row => {
    if (row.seq !== undefined) {
      previous = row.seq;
      return { ...row, anchor: row.seq, side: 0 };
    }
    return { ...row, anchor: previous ?? following[row.index] ?? 0,
      side: previous === undefined && following[row.index] !== undefined ? -1 : 1 };
  });
  return keyed.sort((a, b) => a.anchor - b.anchor || a.side - b.side
    || (a.side === 0 ? a.part - b.part : 0) || a.index - b.index).map(row => row.message);
}

/** An in-flight page must not roll a live run back to its older snapshot.
 * Baseline is the last committed history snapshot for this session. Store updates are
 * immutable; reference changes identify live revisions without text matching. */
export function mergeHistoryWithLive(
  history: Message[], baseline: Message[], current: Message[],
): Message[] {
  const before = new Map(baseline.map(message => [message.id, message]));
  const changed = current.filter(message => before.get(message.id) !== message);
  if (!changed.length) return history;
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
  return orderTranscript(result);
}
