import { create } from 'zustand';

export type SessionCheckpoint = {
  checkpointId: string;
  runId: string;
  sessionId?: string;
  invocationId?: string;
  seqId?: number;
  timestamp?: string | number;
  framework?: string;
  frameworkRef?: Record<string, unknown>;
  phase?: string;
  metadata?: Record<string, unknown>;
};

export type ToolReceipt = {
  receiptId: string;
  idempotencyKey: string;
  toolName: string;
  toolCallId?: string;
  runId?: string;
  checkpointId?: string;
  sessionId?: string;
  invocationId?: string;
  seqId?: number;
  timestamp?: string | number;
  status?: string;
  replayed?: boolean;
  metadata?: Record<string, unknown>;
};

type CheckpointState = {
  checkpointsBySessionId: Record<string, SessionCheckpoint[]>;
  toolReceiptsBySessionId: Record<string, ToolReceipt[]>;
};

type CheckpointActions = {
  setSessionCheckpoints: (sessionId: string, checkpoints: unknown[]) => void;
  upsertSessionCheckpoint: (sessionId: string, checkpoint: unknown) => void;
  getSessionCheckpoints: (sessionId: string | null | undefined) => SessionCheckpoint[];
  setSessionToolReceipts: (sessionId: string, receipts: unknown[]) => void;
  getSessionToolReceipts: (sessionId: string | null | undefined) => ToolReceipt[];
  clearSessionCheckpoints: (sessionId?: string | null) => void;
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalTimestamp(value: unknown): string | number | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isSessionCheckpoint(value: SessionCheckpoint | null): value is SessionCheckpoint {
  return value !== null;
}

function isToolReceipt(value: ToolReceipt | null): value is ToolReceipt {
  return value !== null;
}

function sortCheckpoints(checkpoints: SessionCheckpoint[]) {
  return [...checkpoints].sort((left, right) => {
    const rightSeq = right.seqId ?? -1;
    const leftSeq = left.seqId ?? -1;
    if (rightSeq !== leftSeq) return rightSeq - leftSeq;
    const rightTime = Date.parse(String(right.timestamp || '')) || 0;
    const leftTime = Date.parse(String(left.timestamp || '')) || 0;
    return rightTime - leftTime;
  });
}

function sortToolReceipts(receipts: ToolReceipt[]) {
  return [...receipts].sort((left, right) => {
    const rightSeq = right.seqId ?? -1;
    const leftSeq = left.seqId ?? -1;
    if (rightSeq !== leftSeq) return rightSeq - leftSeq;
    const rightTime = Date.parse(String(right.timestamp || '')) || 0;
    const leftTime = Date.parse(String(left.timestamp || '')) || 0;
    return rightTime - leftTime;
  });
}

export function normalizeSessionCheckpoint(value: unknown): SessionCheckpoint | null {
  const raw = optionalRecord(value);
  if (!raw) return null;

  const checkpointId = text(raw.CheckpointId ?? raw.checkpointId ?? raw.checkpoint_id);
  const runId = text(raw.RunId ?? raw.runId ?? raw.run_id);
  if (!checkpointId || !runId) return null;

  return {
    checkpointId,
    runId,
    sessionId: text(raw.SessionId ?? raw.sessionId ?? raw.session_id) || undefined,
    invocationId: text(raw.InvocationId ?? raw.invocationId ?? raw.invocation_id) || undefined,
    seqId: optionalNumber(raw.SeqId ?? raw.seqId ?? raw.seq_id),
    timestamp: optionalTimestamp(raw.Timestamp ?? raw.timestamp ?? raw.CreatedAt ?? raw.createdAt),
    framework: text(raw.Framework ?? raw.framework) || undefined,
    frameworkRef: optionalRecord(raw.FrameworkRef ?? raw.frameworkRef ?? raw.framework_ref),
    phase: text(raw.Phase ?? raw.phase) || undefined,
    metadata: optionalRecord(raw.Metadata ?? raw.metadata),
  };
}

export function normalizeToolReceipt(value: unknown): ToolReceipt | null {
  const raw = optionalRecord(value);
  if (!raw) return null;

  const receiptId = text(raw.ReceiptId ?? raw.receiptId ?? raw.receipt_id);
  const idempotencyKey = text(raw.IdempotencyKey ?? raw.idempotencyKey ?? raw.idempotency_key);
  const toolName = text(raw.ToolName ?? raw.toolName ?? raw.tool_name);
  if (!receiptId || !idempotencyKey || !toolName) return null;

  return {
    receiptId,
    idempotencyKey,
    toolName,
    toolCallId: text(raw.ToolCallId ?? raw.toolCallId ?? raw.tool_call_id) || undefined,
    runId: text(raw.RunId ?? raw.runId ?? raw.run_id) || undefined,
    checkpointId: text(raw.CheckpointId ?? raw.checkpointId ?? raw.checkpoint_id) || undefined,
    sessionId: text(raw.SessionId ?? raw.sessionId ?? raw.session_id) || undefined,
    invocationId: text(raw.InvocationId ?? raw.invocationId ?? raw.invocation_id) || undefined,
    seqId: optionalNumber(raw.SeqId ?? raw.seqId ?? raw.seq_id),
    timestamp: optionalTimestamp(raw.Timestamp ?? raw.timestamp ?? raw.CreatedAt ?? raw.createdAt),
    status: text(raw.Status ?? raw.status) || undefined,
    replayed: Boolean(raw.Replayed ?? raw.replayed),
    metadata: optionalRecord(raw.Metadata ?? raw.metadata),
  };
}

export const useCheckpointStore = create<CheckpointState & CheckpointActions>()((set, get) => ({
  checkpointsBySessionId: {},
  toolReceiptsBySessionId: {},
  setSessionCheckpoints: (sessionId, checkpoints) => set((state) => ({
    checkpointsBySessionId: {
      ...state.checkpointsBySessionId,
      [sessionId]: sortCheckpoints(
        checkpoints
          .map(normalizeSessionCheckpoint)
          .filter(isSessionCheckpoint)
          .map((item) => ({ ...item, sessionId: item.sessionId || sessionId })),
      ),
    },
  })),
  upsertSessionCheckpoint: (sessionId, checkpoint) => {
    const normalized = normalizeSessionCheckpoint(checkpoint);
    if (!normalized) return;
    set((state) => {
      const current = state.checkpointsBySessionId[sessionId] || [];
      normalized.sessionId = normalized.sessionId || sessionId;
      const existing = new Map(current.map((item) => [item.checkpointId, item]));
      existing.set(normalized.checkpointId, {
        ...existing.get(normalized.checkpointId),
        ...normalized,
      });
      return {
        checkpointsBySessionId: {
          ...state.checkpointsBySessionId,
          [sessionId]: sortCheckpoints([...existing.values()]),
        },
      };
    });
  },
  getSessionCheckpoints: (sessionId) => {
    const key = String(sessionId || '');
    if (!key) return [];
    return get().checkpointsBySessionId[key] || [];
  },
  setSessionToolReceipts: (sessionId, receipts) => set((state) => ({
    toolReceiptsBySessionId: {
      ...state.toolReceiptsBySessionId,
      [sessionId]: sortToolReceipts(
        receipts
          .map(normalizeToolReceipt)
          .filter(isToolReceipt)
          .map((item) => ({ ...item, sessionId: item.sessionId || sessionId })),
      ),
    },
  })),
  getSessionToolReceipts: (sessionId) => {
    const key = String(sessionId || '');
    if (!key) return [];
    return get().toolReceiptsBySessionId[key] || [];
  },
  clearSessionCheckpoints: (sessionId) => set((state) => {
    const key = String(sessionId || '');
    if (!key) return { checkpointsBySessionId: {}, toolReceiptsBySessionId: {} };
    const { [key]: _removedCheckpoint, ...checkpointRest } = state.checkpointsBySessionId;
    const { [key]: _removedReceipt, ...receiptRest } = state.toolReceiptsBySessionId;
    return { checkpointsBySessionId: checkpointRest, toolReceiptsBySessionId: receiptRest };
  }),
}));
