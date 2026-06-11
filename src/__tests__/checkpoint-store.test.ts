import { afterEach, describe, expect, it } from 'vitest';
import {
  normalizeToolReceipt,
  normalizeSessionCheckpoint,
  useCheckpointStore,
} from '../stores/checkpoint.js';

describe('checkpoint store', () => {
  afterEach(() => {
    useCheckpointStore.getState().clearSessionCheckpoints();
  });

  it('normalizes backend checkpoint records and keeps newest entries first', () => {
    const store = useCheckpointStore.getState();

    store.setSessionCheckpoints('session-1', [
      {
        CheckpointId: 'ckpt-1',
        RunId: 'run-1',
        SessionId: 'session-1',
        InvocationId: 'invoke-1',
        SeqId: 12,
        Timestamp: '2026-06-10T10:00:00Z',
        Framework: 'langgraph',
        FrameworkRef: { langgraph: { thread_id: 'tenant:agent:session-1' } },
      },
      {
        CheckpointId: 'ckpt-2',
        RunId: 'run-1',
        SeqId: 14,
        Timestamp: '2026-06-10T10:05:00Z',
      },
      { CheckpointId: '', RunId: 'run-1', SeqId: 15 },
    ]);

    expect(store.getSessionCheckpoints('session-1')).toEqual([
      expect.objectContaining({
        checkpointId: 'ckpt-2',
        runId: 'run-1',
        seqId: 14,
      }),
      expect.objectContaining({
        checkpointId: 'ckpt-1',
        runId: 'run-1',
        sessionId: 'session-1',
        invocationId: 'invoke-1',
        seqId: 12,
        framework: 'langgraph',
        frameworkRef: { langgraph: { thread_id: 'tenant:agent:session-1' } },
      }),
    ]);
  });

  it('upserts checkpoints by checkpoint id within the current session', () => {
    const store = useCheckpointStore.getState();

    store.setSessionCheckpoints('session-1', [
      { CheckpointId: 'ckpt-1', RunId: 'run-1', SeqId: 10 },
    ]);
    store.upsertSessionCheckpoint('session-1', {
      CheckpointId: 'ckpt-1',
      RunId: 'run-1',
      SeqId: 20,
      Phase: 'after_tool',
    });

    expect(store.getSessionCheckpoints('session-1')).toEqual([
      expect.objectContaining({
        checkpointId: 'ckpt-1',
        runId: 'run-1',
        seqId: 20,
        phase: 'after_tool',
      }),
    ]);
  });

  it('returns stable empty arrays for missing session data', () => {
    const store = useCheckpointStore.getState();

    expect(store.getSessionCheckpoints(null)).toBe(store.getSessionCheckpoints(null));
    expect(store.getSessionCheckpoints('missing')).toBe(store.getSessionCheckpoints('missing'));
    expect(store.getSessionToolReceipts(null)).toBe(store.getSessionToolReceipts(null));
    expect(store.getSessionToolReceipts('missing')).toBe(store.getSessionToolReceipts('missing'));
  });

  it('returns null for malformed checkpoint records', () => {
    expect(normalizeSessionCheckpoint({ CheckpointId: 'ckpt-1' })).toBeNull();
    expect(normalizeSessionCheckpoint({ RunId: 'run-1' })).toBeNull();
  });

  it('normalizes tool receipt records and keeps newest entries first', () => {
    const store = useCheckpointStore.getState();

    store.setSessionToolReceipts('session-1', [
      {
        ReceiptId: 'tr-1',
        IdempotencyKey: 'tool_receipt:1',
        ToolName: 'write_workspace_file',
        ToolCallId: 'call-1',
        RunId: 'run-1',
        CheckpointId: 'ckpt-1',
        SeqId: 8,
        Status: 'completed',
      },
      {
        ReceiptId: 'tr-2',
        IdempotencyKey: 'tool_receipt:2',
        ToolName: 'send_notification',
        ToolCallId: 'call-2',
        RunId: 'run-1',
        CheckpointId: 'ckpt-2',
        SeqId: 12,
        Status: 'failed',
        Replayed: true,
      },
    ]);

    expect(store.getSessionToolReceipts('session-1')).toEqual([
      expect.objectContaining({
        receiptId: 'tr-2',
        idempotencyKey: 'tool_receipt:2',
        toolName: 'send_notification',
        checkpointId: 'ckpt-2',
        status: 'failed',
        replayed: true,
      }),
      expect.objectContaining({
        receiptId: 'tr-1',
        toolName: 'write_workspace_file',
      }),
    ]);
  });

  it('returns null for malformed tool receipt records', () => {
    expect(normalizeToolReceipt({ ReceiptId: 'tr-1' })).toBeNull();
    expect(normalizeToolReceipt({ ToolName: 'write_workspace_file' })).toBeNull();
  });
});
