/**
 * agent-kernel/v1 session event frames → legacy SessionEventRecord.
 *
 * RunAgent on a kernel-backed agent returns an AgentControl receipt (JSON)
 * instead of a Responses SSE stream. The engine then subscribes to
 * SubscribeSessionEvents (raw kernel envelopes) and translates each frame
 * into the legacy session-event read model so the existing dispatcher /
 * message merge / interaction ingestion paths keep working unchanged.
 *
 * Interaction/v1 frames are passed through verbatim: the interaction
 * adapter already understands the kernel envelope shape.
 */

export type KernelSessionEventFrame = Record<string, unknown>;

export type LegacySessionEventRecord = {
  EventId?: string;
  EventType?: string;
  SessionId?: string;
  InvocationId?: string;
  Content?: Record<string, unknown>;
  Metadata?: Record<string, unknown>;
  SeqId?: number;
  Timestamp?: string;
  [key: string]: unknown;
};

const RUN_STATUS_BY_EVENT_TYPE: Record<string, string> = {
  'run.started': 'in_progress',
  'run.progress': 'in_progress',
  'run.completed': 'completed',
  'run.failed': 'failed',
  'run.canceled': 'cancelled',
  'run.interrupted': 'interrupted',
};

const TERMINAL_CONTROL_STATES = new Set(['completed', 'failed', 'cancelled', 'canceled']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function frameNativeKind(frame: KernelSessionEventFrame): string {
  const source = asRecord(frame.source);
  const metadata = source ? asRecord(source.metadata) : null;
  return String(metadata?.native_item_kind || '');
}

function frameParts(frame: KernelSessionEventFrame, key: 'initial' | 'snapshot'): unknown[] {
  const holder = asRecord(frame[key]);
  const parts = holder?.parts;
  return Array.isArray(parts) ? parts : [];
}

function partText(part: unknown): string {
  const record = asRecord(part);
  if (!record) return '';
  if (typeof record.text === 'string') return record.text;
  const data = asRecord(record.data);
  if (data) {
    const content = data.content;
    if (Array.isArray(content)) {
      return content
        .map((entry) => String(asRecord(entry)?.text || ''))
        .join('');
    }
    for (const key of ['text', 'output', 'stdout', 'stderr']) {
      if (data[key] != null) return String(data[key]);
    }
  }
  return '';
}

function partsText(parts: unknown[]): string {
  return parts.map(partText).join('');
}

function looksLikeUserMessage(parts: unknown[]): boolean {
  return parts.some((part) => asRecord(asRecord(part)?.data)?.type === 'userMessage');
}

function toolPayload(parts: unknown[]): unknown {
  if (parts.length === 1) {
    const data = asRecord(asRecord(parts[0])?.data);
    if (data) return data;
  }
  const text = partsText(parts);
  return text || null;
}

/**
 * Stateful translator: accumulates item.updated text deltas per part so the
 * emitted assistant_stream_snapshot records are cumulative (the legacy read
 * model treats snapshots as full-text snapshots, not deltas).
 */
export class KernelRunEventTranslator {
  private readonly textByPart = new Map<string, string>();
  private readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  translate(frame: KernelSessionEventFrame): LegacySessionEventRecord | null {
    if (!asRecord(frame)) return null;
    const seq = Number(frame.seq);
    if (!Number.isFinite(seq) || seq <= 0) return null;
    const family = String(frame.family || '');
    const eventType = String(frame.event_type || '');
    const runId = String(frame.run_id || '');

    const base = (): LegacySessionEventRecord => ({
      EventId: frame.event_id ? String(frame.event_id) : `kernel-${seq}`,
      SessionId: this.sessionId,
      InvocationId: runId || undefined,
      SeqId: seq,
    });

    if (family === 'interaction') {
      // The interaction adapter reads interaction facts from
      // envelope.payload; wrap the flattened kernel frame so the adapter's
      // payload/body fallbacks find interaction_id / kind / outcome.
      return {
        ...base(),
        EventType: eventType,
        payload: frame,
      } as LegacySessionEventRecord;
    }

    if (family === 'control') {
      if (eventType === 'control.run_transition') {
        const state = String(frame.state || '').toLowerCase();
        if (TERMINAL_CONTROL_STATES.has(state)) {
          return { ...base(), EventType: 'run_status', Content: { status: state } };
        }
      }
      return null;
    }

    if (family !== 'runtime') return null;

    const runStatus = RUN_STATUS_BY_EVENT_TYPE[eventType];
    if (runStatus) {
      return { ...base(), EventType: 'run_status', Content: { status: runStatus } };
    }

    const nativeKind = frameNativeKind(frame);

    if (eventType === 'item.started') {
      const parts = frameParts(frame, 'initial');
      if (nativeKind === 'userMessage' || looksLikeUserMessage(parts)) return null;
      if (nativeKind === 'agentMessage' || (!nativeKind && frame.item_kind === 'message')) {
        return {
          ...base(),
          EventType: 'assistant_stream_snapshot',
          Content: { parts: [{ text: '' }] },
        };
      }
      if (nativeKind && nativeKind !== 'notification') {
        return {
          ...base(),
          EventType: 'tool_call',
          Metadata: {
            call_id: String(frame.item_id || ''),
            tool_name: nativeKind,
            run_id: runId,
            tool_args: toolPayload(parts),
          },
        };
      }
      return null;
    }

    if (eventType === 'item.updated') {
      const parts = frameParts(frame, 'snapshot');
      const part = asRecord(parts[0]);
      const partId = String(part?.part_id || frame.item_id || seq);
      const op = String(frame.op || 'replace');
      const delta = partsText(parts);
      const current = this.textByPart.get(partId) || '';
      const next = op === 'append' ? current + delta : delta;
      this.textByPart.set(partId, next);
      if (nativeKind === 'agentMessage' || (!nativeKind && frame.item_kind === 'message')) {
        return {
          ...base(),
          EventType: 'assistant_stream_snapshot',
          Content: { parts: [{ text: next }] },
        };
      }
      if (nativeKind === 'reasoning' || frame.item_kind === 'reasoning') {
        return {
          ...base(),
          EventType: 'reasoning',
          Content: { text: next },
        };
      }
      return null;
    }

    if (eventType === 'item.completed') {
      const parts = frameParts(frame, 'snapshot');
      if (nativeKind === 'userMessage' || looksLikeUserMessage(parts)) {
        return {
          ...base(),
          EventType: 'user_message',
          Content: { parts: [{ text: partsText(parts) }] },
        };
      }
      if (nativeKind === 'agentMessage' || (!nativeKind && frame.item_kind === 'message')) {
        const text = partsText(parts);
        this.textByPart.set(String(asRecord(parts[0])?.part_id || frame.item_id || seq), text);
        return {
          ...base(),
          EventType: 'assistant_message',
          Content: { parts: [{ text }] },
        };
      }
      if (nativeKind === 'reasoning' || frame.item_kind === 'reasoning') {
        return { ...base(), EventType: 'reasoning', Content: { text: partsText(parts) } };
      }
      if (nativeKind && nativeKind !== 'notification') {
        return {
          ...base(),
          EventType: 'tool_result',
          Metadata: {
            call_id: String(frame.item_id || ''),
            tool_name: nativeKind,
            run_id: runId,
            tool_output: toolPayload(parts),
          },
        };
      }
      return null;
    }

    return null;
  }
}

/** Parsed RunAgent receipt on the kernel control path (ActionResponse.Data). */
export type KernelRunReceipt = {
  status: string;
  messageId?: string | null;
  runId?: string | null;
  acceptedSeq?: number | null;
  error?: { code?: string; message?: string } | null;
};

/**
 * Detect the kernel receipt JSON body on a RunAgent response stream. Returns
 * the receipt, or a stream with the already-read bytes prepended when the
 * body is an SSE stream (legacy runtime path).
 */
export async function peekKernelReceipt(
  stream: ReadableStream<Uint8Array>,
): Promise<{ receipt: KernelRunReceipt | null; stream: ReadableStream<Uint8Array> }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let receipt: KernelRunReceipt | null = null;
  let readDone = false;

  const looksLikeSse = (text: string): boolean =>
    text.includes('data:') || text.includes('event:') || text.includes(':');

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) {
        readDone = true;
        break;
      }
      const trimmed = buffer.trimStart();
      if (trimmed.startsWith('{')) {
        if (isCompleteJson(buffer)) {
          receipt = parseReceipt(buffer);
          break;
        }
      } else if (looksLikeSse(buffer)) {
        break;
      }
    }
  } catch (error) {
    // Fall through: whatever was buffered is replayed on the returned stream.
    void error;
  }

  const prefix = new TextEncoder().encode(buffer);
  const replay = new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix.length > 0) controller.enqueue(prefix);
      if (readDone || receipt) {
        controller.close();
        return;
      }
      const pump = (): Promise<void> =>
        reader
          .read()
          .then(({ value: chunk, done }) => {
            if (chunk) controller.enqueue(chunk);
            if (done) {
              controller.close();
              return undefined;
            }
            return pump();
          })
          .catch(() => {
            try {
              controller.close();
            } catch {
              // already closed (abort/cancel): nothing to do
            }
          });
      void pump();
    },
    cancel() {
      void reader.cancel();
    },
  });

  return { receipt, stream: replay };
}

function isCompleteJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.endsWith('}')) return false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of trimmed) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === '{' || char === '[') depth += 1;
    if (char === '}' || char === ']') depth -= 1;
  }
  return depth === 0;
}

function parseReceipt(text: string): KernelRunReceipt | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const data = asRecord(parsed.Data);
    const status = String(data?.ReceiptStatus || '');
    if (!status) return null;
    const error = asRecord(data?.Error);
    return {
      status,
      messageId: (data?.MessageId as string | null) ?? null,
      runId: (data?.RunId as string | null) ?? null,
      acceptedSeq: (data?.AcceptedSeq as number | null) ?? null,
      error: error
        ? { code: String(error.code || ''), message: String(error.message || '') }
        : null,
    };
  } catch {
    return null;
  }
}
