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
    session_event?: Record<string, unknown>;
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
  const runtimeEvent = record(raw?.Content?.runtime_event);
  if (runtimeEvent && String(runtimeEvent.event_type || '')) {
    return {
      ...runtimeEvent,
      family: 'runtime',
      seq: Number(raw.SeqId || runtimeEvent.seq || 0),
      timestamp: raw.Timestamp || runtimeEvent.timestamp,
    };
  }

  const envelope = record(raw?.Content?.session_event);
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
    blocks: buildBlocksFromHistory({
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
  const fallbackModels = fallback.filter((message) => message.role === 'model');
  const canonicalModels = canonical.filter((message) => message.role === 'model');
  const lastCanonicalModel = canonicalModels.at(-1);
  const lastFallbackModel = fallbackModels.at(-1);

  return canonical.map((message) => {
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

  const orderedRecords = [...(records || [])].sort(
    (left, right) => Number(left.SeqId || 0) - Number(right.SeqId || 0),
  );
  for (const persisted of orderedRecords) {
    const frame = persistedRuntimeFrame(persisted);
    if (!frame) continue;
    const runId = String(frame.run_id || '').trim();
    if (runId) canonicalRunIds.add(runId);
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
  const projectedRunIds = new Set(projected.map((message) => String(message.invocationId || '')));
  const fallbackByRun = new Map<string, Message[]>();
  for (const message of fallbackMessages) {
    const runId = String(message.invocationId || '');
    if (!runId) continue;
    fallbackByRun.set(runId, [...(fallbackByRun.get(runId) || []), message]);
  }

  const canonicalMessages = [...projectedRunIds].flatMap((runId) => enrichCanonicalRun(
    projected.filter((message) => message.invocationId === runId),
    fallbackByRun.get(runId) || [],
  ));
  const retainedFallback = fallbackMessages.filter((message) => (
    message.role === 'a2ui'
    || !message.invocationId
    || !projectedRunIds.has(message.invocationId)
  ));
  const messages = [...retainedFallback, ...canonicalMessages].sort(
    (left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0),
  );

  return {
    messages,
    canonicalRunIds: [...projectedRunIds],
    translatedEvents,
  };
}
