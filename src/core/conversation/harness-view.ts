import type { ConversationItem } from './types.js';
import type { Message } from '../../components/chat/types.js';

export const HARNESS_VIEW_CONTRACT = 'agentkit.engine-view/v1';
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_VIEW_EVENTS = 2000;

export type HarnessViewEvent = Record<string, unknown> & { seq: number };
export type HarnessViewUpdate = { sha256: string; event: HarnessViewEvent };

export type HarnessRunView = {
  runId: string;
  sha256: string;
  events: HarnessViewEvent[];
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function readHarnessViewEvent(value: unknown): HarnessViewUpdate | null {
  const payload = record(value);
  const event = record(payload?.event);
  if (payload?.contract !== HARNESS_VIEW_CONTRACT
    || typeof payload.sha256 !== 'string' || !SHA256.test(payload.sha256)
    || event?.schema !== 'agentkit.engine-event/v1'
    || typeof event.kind !== 'string'
    || typeof event.seq !== 'number' || !Number.isSafeInteger(event.seq) || event.seq <= 0) return null;
  return { sha256: payload.sha256, event: event as HarnessViewEvent };
}

/** Add the same presentation row during a Responses stream or after history
 * reload. The public invocation ID ties both sources to the assistant reply. */
export function mergeHarnessViewMessage(messages: Message[], runId: string, update: HarnessViewUpdate,
  position: { anchorId?: string; timestamp: number; seq?: number }): Message[] {
  const id = `harness-view:${runId}`;
  const current = messages.find(message => message.id === id)?.harnessView;
  if (current && (current.sha256 !== update.sha256 || current.events.some(event => event.seq === update.event.seq))) return messages;
  const harnessView = { runId, sha256: update.sha256,
    events: [...(current?.events ?? []), update.event].sort((a, b) => a.seq - b.seq).slice(-MAX_VIEW_EVENTS) };
  if (current) return messages.map(message => message.id === id ? { ...message, harnessView } : message);
  const index = messages.findIndex(message => message.id === position.anchorId
    || message.role === 'model' && (message.invocationId === runId || message.runId === runId));
  const anchor = index < 0 ? undefined : messages[index];
  const row: Message = { id, role: 'model', content: '', timestamp: position.timestamp,
    eventType: 'harness_view', runId, invocationId: runId, harnessView,
    ...(position.seq === undefined ? {} : { historyOrder: { seq: position.seq } }) };
  return anchor ? [...messages.slice(0, index), row, ...messages.slice(index)] : [...messages, row];
}

/** Group presentation events by their Run's pinned view. */
export function collectHarnessViews(items: readonly ConversationItem[]): HarnessRunView[] {
  const runs = new Map<string, { sha256: string; events: Map<number, HarnessViewEvent> }>();
  for (const item of items) {
    if (item.visibility !== 'public' || item.parentItemId) continue;
    const view = readHarnessViewEvent(item.payload.harnessView);
    if (!view) continue;
    let run = runs.get(item.runId);
    if (!run) {
      run = { sha256: view.sha256, events: new Map() };
      runs.set(item.runId, run);
    }
    if (run.sha256 === view.sha256 && !run.events.has(view.event.seq)) {
      run.events.set(view.event.seq, view.event);
    }
  }
  return Array.from(runs, ([runId, run]) => ({
    runId,
    sha256: run.sha256,
    events: [...run.events.values()].sort((a, b) => a.seq - b.seq).slice(-MAX_VIEW_EVENTS),
  }));
}
