import type { Message } from '../components/chat/types.js';
import { buildBlocksFromHistory } from '../core/run/blocks.js';
import {
  KernelRunEventTranslator,
  type KernelSessionEventFrame,
} from '../core/stream/kernel-events.js';
import type { SessionEventRecord } from '../types/session-events.js';
import { buildMessagesFromSessionEvents } from './session-events.js';

export type PersistedSessionEventRecord = SessionEventRecord & {
  Content?: SessionEventRecord['Content'] & {
    runtime_event?: Record<string, unknown>;
    runtimeEvent?: Record<string, unknown>;
    session_event?: Record<string, unknown>;
    sessionEvent?: Record<string, unknown>;
  };
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function eventTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // RuntimeEvent/v2 timestamps are Unix seconds while the legacy message
    // projection and JavaScript Date APIs use milliseconds. Normalise before
    // sorting or a refreshed run places every user row after all model items.
    return value > 0 && value < 100_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value.trim());
    if (Number.isFinite(numeric)) {
      return numeric > 0 && numeric < 100_000_000_000 ? numeric * 1000 : numeric;
    }
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/**
 * Extract the canonical RuntimeEvent/v2 frame persisted inside a
 * ListSessionEvents record. The server stores both the SessionEvent envelope
 * and a flattened runtime_event projection; the latter already carries the
 * unified Session seq used by replay cursors.
 */
export function persistedRuntimeFrame(
  raw: PersistedSessionEventRecord,
): KernelSessionEventFrame | null {
  const runtimeEvent = record(raw?.Content?.runtime_event || raw?.Content?.runtimeEvent);
  if (runtimeEvent && String(runtimeEvent.event_type || '')) {
    return {
      ...runtimeEvent,
      family: 'runtime',
      seq: Number(raw.SeqId || runtimeEvent.seq || 0),
      timestamp: raw.Timestamp || runtimeEvent.timestamp,
    };
  }

  const envelope = record(raw?.Content?.session_event || raw?.Content?.sessionEvent);
  if (!envelope || String(envelope.family || '') !== 'runtime') return null;
  const payload = record(envelope.payload);
  if (!payload || !String(payload.event_type || envelope.event_type || '')) return null;
  return {
    ...payload,
    family: 'runtime',
    event_type: payload.event_type || envelope.event_type,
    run_id: payload.run_id || envelope.run_id,
    seq: Number(raw.SeqId || envelope.seq || payload.seq || 0),
    timestamp: raw.Timestamp || envelope.timestamp || payload.timestamp,
  };
}

function withHistoryBlocks(message: Message): Message {
  if (message.role !== 'model') return message;
  return {
    ...message,
    // Canonical blocks carry provider identities (for example callId) that
    // legacy reasoning/tools fields cannot reconstruct. Rebuild only when a
    // historical source truly has no ordered block projection.
    blocks: message.blocks?.length
      ? message.blocks
      : buildBlocksFromHistory({
          content: message.content,
          reasoning: message.reasoning,
          tools: message.tools,
        }),
  };
}

function enrichCanonicalRun(
  canonical: Message[],
  fallback: Message[],
): Message[] {
  const fallbackUser = fallback.find((message) => message.role === 'user');
  const hasCanonicalUser = canonical.some((message) => message.role === 'user');
  const fallbackModels = fallback.filter((message) => message.role === 'model');
  const canonicalModels = canonical.filter((message) => message.role === 'model');
  const lastCanonicalModel = canonicalModels.at(-1);
  const lastFallbackModel = fallbackModels.at(-1);

  const enriched = canonical.map((message) => {
    if (message.role === 'user' && fallbackUser) {
      return {
        ...message,
        ...fallbackUser,
        invocationId: message.invocationId || fallbackUser.invocationId,
      };
    }
    if (message === lastCanonicalModel && lastFallbackModel) {
      return withHistoryBlocks({
        ...message,
        responseId: lastFallbackModel.responseId || message.responseId,
        traceId: lastFallbackModel.traceId || message.traceId,
        rootSpanId: lastFallbackModel.rootSpanId || message.rootSpanId,
      });
    }
    return withHistoryBlocks(message);
  });

  // Some RuntimeEvent/v2 producers persist only model-side activity. The
  // cumulative Messages row remains the durable source for that turn's user
  // input, so retain it when canonical replay has no user item of its own.
  return fallbackUser && !hasCanonicalUser
    ? [fallbackUser, ...enriched]
    : enriched;
}

/**
 * A newest-first event page can begin in the middle of a long run. Keep the
 * complete Messages projection for readable user/assistant text, but enrich
 * its last assistant row with any durable reasoning and tool facts already
 * present in the loaded event window. This lets upward pagination reveal old
 * tool calls page by page without waiting until the run.started boundary is
 * fetched.
 */
function enrichPartialCanonicalRun(
  fallback: Message[],
  canonical: Message[],
): Message[] {
  const partialModels = canonical.filter((message) => message.role === 'model');
  const partialTools = partialModels.reduce<NonNullable<Message['tools']>>(
    (tools, message) => ({ ...tools, ...(message.tools || {}) }),
    {},
  );
  const partialReasoning = partialModels
    .map((message) => String(message.reasoning || '').trim())
    .filter(Boolean)
    .join('\n\n');
  const target = [...fallback].reverse().find((message) => message.role === 'model');
  if (!target || (Object.keys(partialTools).length === 0 && !partialReasoning)) {
    return fallback;
  }
  return fallback.map((message) => (
    message === target
      ? withHistoryBlocks({
          ...message,
          reasoning: message.reasoning || partialReasoning || undefined,
          tools: Object.keys(partialTools).length > 0
            ? { ...(message.tools || {}), ...partialTools }
            : message.tools,
        })
      : message
  ));
}

/**
 * A RuntimeEvent/v2 run only replaces the compatibility projection once its
 * terminal assistant output is present. A user item, run transition, or an
 * open stream snapshot alone proves that the run exists, but does not prove
 * that replay can render its reply. Treating that partial evidence as
 * authoritative used to erase a persisted assistant message after refresh.
 */
function completedCanonicalRunIds(messages: Message[]): Set<string> {
  return new Set(
    messages
      .filter((message) => (
        message.role === 'model'
        && message.eventType === 'assistant_message'
        && Boolean(String(message.content || '').trim())
        && Boolean(message.invocationId)
      ))
      .map((message) => String(message.invocationId)),
  );
}

const INTERACTION_RESOLUTION_EVENTS = new Set([
  'approval.resolved',
  'interaction.resolved',
  'interaction.cancelled',
  'interaction.canceled',
  'a2ui.action',
]);

function cancelledInteractionRunIds(
  records: PersistedSessionEventRecord[],
): Set<string> {
  const cancelled = new Set<string>();
  for (const persisted of records) {
    const content = record(persisted.Content) || {};
    const runtime = record(content.runtime_event || content.runtimeEvent) || {};
    const payload = record(content.payload) || record(runtime.payload) || {};
    const eventType = String(
      persisted.EventType
      || content.event_type
      || content.eventType
      || runtime.event_type
      || '',
    ).toLowerCase();
    if (!INTERACTION_RESOLUTION_EVENTS.has(eventType)) continue;
    const action = String(
      content.outcome
      || content.action
      || content.name
      || content.status
      || payload.outcome
      || payload.action
      || payload.name
      || payload.status
      || '',
    ).toLowerCase();
    if (!['cancel', 'cancelled', 'canceled'].includes(action)) continue;
    const runId = String(
      persisted.InvocationId
      || content.runId
      || content.run_id
      || payload.runId
      || payload.run_id
      || runtime.run_id
      || '',
    ).trim();
    if (runId) cancelled.add(runId);
  }
  return cancelled;
}

/**
 * Rebuild the transcript for runs that have canonical RuntimeEvent/v2
 * history. Cumulative ListSessionMessages rows remain only a compatibility
 * fallback for legacy runs; they never co-own a canonical run.
 */
export function rebuildPersistedSessionHistory(
  fallbackMessages: Message[],
  records: PersistedSessionEventRecord[],
  sessionId: string,
): {
  messages: Message[];
  canonicalRunIds: string[];
  translatedEvents: SessionEventRecord[];
} {
  const translator = new KernelRunEventTranslator(sessionId);
  const translatedEvents: SessionEventRecord[] = [];
  const canonicalRunIds = new Set<string>();
  const fullyObservedRunIds = new Set<string>();

  const orderedRecords = [...(records || [])].sort(
    (left, right) => Number(left.SeqId || 0) - Number(right.SeqId || 0),
  );
  const startsAtSessionBeginning = Number(orderedRecords[0]?.SeqId || 0) <= 1;
  for (const persisted of orderedRecords) {
    const frame = persistedRuntimeFrame(persisted);
    if (!frame) continue;
    const runId = String(frame.run_id || '').trim();
    if (runId) {
      canonicalRunIds.add(runId);
      const source = record(frame.source);
      const sourceMetadata = record(source?.metadata);
      const containsRunStart = String(frame.event_type || '') === 'run.started';
      const containsUserItem = sourceMetadata?.native_item_kind === 'userMessage';
      if (startsAtSessionBeginning || containsRunStart || containsUserItem) {
        fullyObservedRunIds.add(runId);
      }
    }
    const translated = translator.translate(frame);
    if (!translated) continue;
    translatedEvents.push({
      ...translated,
      SeqId: Number(persisted.SeqId || translated.SeqId || 0),
      Timestamp: eventTimestamp(persisted.Timestamp || translated.Timestamp),
    } as SessionEventRecord);
  }

  const projected = (buildMessagesFromSessionEvents(translatedEvents) as Message[])
    .filter((message) => message.invocationId && canonicalRunIds.has(message.invocationId));
  const fallbackByRun = new Map<string, Message[]>();
  for (const message of fallbackMessages) {
    const runId = String(message.invocationId || '');
    if (!runId) continue;
    fallbackByRun.set(runId, [...(fallbackByRun.get(runId) || []), message]);
  }

  // A partially persisted canonical run must never make the older Server
  // projection disappear. This matters during upgrade: a historical runtime
  // may have written the user item but not a terminal agentMessage item.
  const completeCanonicalRunIds = new Set(
    [...completedCanonicalRunIds(projected)].filter((runId) => fullyObservedRunIds.has(runId)),
  );
  const cancelledRunIds = cancelledInteractionRunIds(orderedRecords);
  const canonicalMessages = [...completeCanonicalRunIds].flatMap((runId) => enrichCanonicalRun(
    projected.filter((message) => message.invocationId === runId),
    fallbackByRun.get(runId) || [],
  ));
  const partialFallbackByRun = new Map<string, Message[]>();
  for (const [runId, fallback] of fallbackByRun) {
    if (completeCanonicalRunIds.has(runId) || !canonicalRunIds.has(runId)) continue;
    partialFallbackByRun.set(
      runId,
      enrichPartialCanonicalRun(
        fallback,
        projected.filter((message) => message.invocationId === runId),
      ),
    );
  }
  const partialFallbackMessageById = new Map(
    [...partialFallbackByRun.values()].flat().map((message) => [message.id, message]),
  );
  const retainedFallback = fallbackMessages.filter((message) => (
    !(message.role === 'model'
      && message.invocationId
      && cancelledRunIds.has(message.invocationId))
    && (
      message.role === 'a2ui'
      || !message.invocationId
      || !completeCanonicalRunIds.has(message.invocationId)
    )
  )).map((message) => partialFallbackMessageById.get(message.id) || message);
  const messages = [...retainedFallback, ...canonicalMessages].sort(
    (left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0),
  );

  return {
    messages,
    canonicalRunIds: [...completeCanonicalRunIds],
    translatedEvents,
  };
}
