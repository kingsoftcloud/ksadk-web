import { describe, expect, it } from 'vitest';
import {
  ContractMismatchError,
  decodeAgentStatusSnapshot,
  decodeCapabilityMatrix,
  decodeReceipt,
  decodeActionReceipt,
  decodeSessionEventEnvelope,
} from '../types/agent-control.js';
import {
  SessionEventConflictError,
  createSessionEventCursor,
} from '../utils/session-event-history.js';

const ACCEPTED_RECEIPT = {
  schema_version: 1,
  command_id: '4bf84e1b-f4cd-4c55-907f-2dc5e676b119',
  status: 'accepted',
  message_id: '11111111-2222-3333-4444-555555555555',
  run_id: 'run-1',
  accepted_seq: 42,
};

const QUEUE_FULL_RECEIPT = {
  schema_version: 1,
  command_id: '4bf84e1b-f4cd-4c55-907f-2dc5e676b119',
  status: 'queue_full',
  error: {
    code: 'queue_full',
    message: 'inbox depth reached limit',
    retryable: true,
    details: { limit: 128 },
  },
};

const CAPABILITY_MATRIX = {
  schema_version: 1,
  cancel: { supported: true, mode: 'native' },
  pause: { supported: false, mode: 'unavailable', reason: 'runtime_pause_not_supported' },
  resume: { supported: true, mode: 'native' },
  submit_interaction: { supported: true, mode: 'native' },
  attach: { supported: true, mode: 'native' },
  steer: { supported: true, mode: 'native' },
  inject: { supported: true, mode: 'native' },
  checkpoint: { supported: false, mode: 'unavailable', reason: 'runtime_checkpoint_not_supported' },
  durable_restore: { supported: true, mode: 'native' },
};

const RUNTIME_EVENT = {
  schema_version: 1,
  event_id: '614e828c-fed7-5202-a07d-354cfa1942a0',
  session_id: 'session-1',
  seq: 20,
  timestamp: '2026-08-17T00:00:01Z',
  family: 'runtime',
  family_version: 2,
  event_type: 'run.message.delta',
  payload: { text: 'hello', delta_index: 0 },
  run_id: 'run-1',
  causation_id: 'cmd-4bf84e1b',
  correlation_id: 'corr-1',
  actor_ref: 'worker-1',
};

describe('agent-kernel/v1 contract decoders', () => {
  it('decodes an accepted receipt', () => {
    const receipt = decodeReceipt(ACCEPTED_RECEIPT);
    expect(receipt.status).toBe('accepted');
    expect(receipt.accepted_seq).toBe(42);
    expect(receipt.extensions).toEqual({});
  });

  it('decodes a queue_full receipt with retryable error', () => {
    const receipt = decodeReceipt(QUEUE_FULL_RECEIPT);
    expect(receipt.status).toBe('queue_full');
    expect(receipt.error?.retryable).toBe(true);
    expect(receipt.error?.details).toEqual({ limit: 128 });
  });

  it('rejects receipts with a wrong schema_version', () => {
    expect(() => decodeReceipt({ ...ACCEPTED_RECEIPT, schema_version: 2 })).toThrow(ContractMismatchError);
  });

  it('rejects non-object receipts', () => {
    expect(() => decodeReceipt('accepted')).toThrow(ContractMismatchError);
  });

  it('keeps unknown optional receipt fields in extensions', () => {
    const receipt = decodeReceipt({ ...ACCEPTED_RECEIPT, queue_position: 3 });
    expect(receipt.extensions).toEqual({ queue_position: 3 });
  });

  it('decodes the runtime capability matrix', () => {
    const matrix = decodeCapabilityMatrix(CAPABILITY_MATRIX);
    expect(matrix.pause).toEqual({
      supported: false,
      mode: 'unavailable',
      reason: 'runtime_pause_not_supported',
      extensions: {},
    });
  });

  it('decodes optional Runtime v2 goal loop and plan capabilities without changing legacy matrices', () => {
    const native = { supported: true, mode: 'native' } as const;
    const matrix = decodeCapabilityMatrix({
      ...CAPABILITY_MATRIX,
      goal: native,
      loop: native,
      plan: native,
    });

    expect(matrix.goal).toMatchObject(native);
    expect(matrix.loop).toMatchObject(native);
    expect(matrix.plan).toMatchObject(native);
    expect(matrix.extensions).toEqual({});

    const legacy = decodeCapabilityMatrix(CAPABILITY_MATRIX);
    expect(legacy.goal).toBeUndefined();
    expect(legacy.loop).toBeUndefined();
    expect(legacy.plan).toBeUndefined();
  });

  it('rejects a capability matrix that drops required capabilities', () => {
    const { checkpoint, ...partial } = CAPABILITY_MATRIX;
    expect(checkpoint).toBeDefined();
    expect(() => decodeCapabilityMatrix(partial)).toThrow(ContractMismatchError);
  });

  it('decodes a session event envelope', () => {
    const envelope = decodeSessionEventEnvelope(RUNTIME_EVENT);
    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      expect(envelope.value.seq).toBe(20);
      expect(envelope.value.family).toBe('runtime');
      expect(envelope.value.event_type).toBe('run.message.delta');
    }
  });

  it('normalizes legacy camelCase session event envelopes at the compatibility boundary', () => {
    const envelope = decodeSessionEventEnvelope({
      schemaVersion: 1,
      eventId: 'legacy-event-1',
      sessionId: 'session-legacy',
      seq: 7,
      timestamp: '2026-08-17T00:00:01Z',
      family: 'runtime',
      familyVersion: 2,
      eventType: 'run.message.delta',
      payload: { text: 'legacy' },
      runId: 'run-legacy',
      correlationId: 'corr-legacy',
      legacyDebugTag: 'preserved',
    });
    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      expect(envelope.value).toMatchObject({
        schema_version: 1,
        event_id: 'legacy-event-1',
        session_id: 'session-legacy',
        seq: 7,
        family_version: 2,
        event_type: 'run.message.delta',
        run_id: 'run-legacy',
        correlation_id: 'corr-legacy',
        extensions: { legacyDebugTag: 'preserved' },
      });
    }
  });

  it('accepts PascalCase aliases emitted by older session history endpoints', () => {
    const envelope = decodeSessionEventEnvelope({
      SchemaVersion: 1,
      EventId: 'legacy-event-2',
      SessionId: 'session-legacy',
      SeqId: 8,
      Timestamp: '2026-08-17T00:00:02Z',
      Family: 'runtime',
      FamilyVersion: 2,
      EventType: 'run.completed',
      Payload: { status: 'completed' },
    });
    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      expect(envelope.value.seq).toBe(8);
      expect(envelope.value.event_type).toBe('run.completed');
      expect(envelope.value.payload).toEqual({ status: 'completed' });
    }
  });

  it('keeps unknown families addressable for the cursor without displaying them', () => {
    const envelope = decodeSessionEventEnvelope({
      ...RUNTIME_EVENT,
      seq: 21,
      family: 'job',
      event_type: 'job.tick',
    });
    expect(envelope.ok).toBe(true);

    const cursor = createSessionEventCursor();
    cursor.accept(RUNTIME_EVENT);
    cursor.accept({ ...RUNTIME_EVENT, seq: 21, family: 'job', event_type: 'job.tick' });
    expect(cursor.lastSeq).toBe(21);
    // Unknown families advance the cursor but are not projected for display.
    expect(cursor.displayableEvents().map((event) => event.seq)).toEqual([20]);
  });

  it('flags envelopes that violate the session event contract', () => {
    const envelope = decodeSessionEventEnvelope({ ...RUNTIME_EVENT, seq: -1 });
    expect(envelope.ok).toBe(false);
  });

  it('decodes an agent status snapshot with the embedded capability matrix', () => {
    const snapshot = decodeAgentStatusSnapshot({
      schema_version: 1,
      agent_instance_id: 'instance-1',
      instance_state: 'ready',
      session_id: 'session-1',
      active_run_id: 'run-1',
      active_run_state: 'running',
      inbox_depth: 3,
      activation_id: 'activation-1',
      lease_expires_at: '2026-08-17T00:01:00Z',
      capability: CAPABILITY_MATRIX,
    });
    expect(snapshot.instance_state).toBe('ready');
    expect(snapshot.capability.pause.supported).toBe(false);
  });

  it('treats conflicting duplicate seq content as a protocol error', () => {
    const cursor = createSessionEventCursor();
    cursor.accept(RUNTIME_EVENT);
    expect(() => cursor.accept({ ...RUNTIME_EVENT, payload: { text: 'tampered' } })).toThrow(
      SessionEventConflictError,
    );
  });
});


describe('public Action receipt boundary', () => {
  it('normalizes the Server Data field names without relaxing the receipt contract', () => {
    expect(decodeActionReceipt({ SchemaVersion: 1, CommandId: 'cmd-1', Status: 'accepted',
      ReceiptStatus: 'accepted', MessageId: 'msg-1', RunId: null, AcceptedSeq: 3,
    })).toMatchObject({ schema_version: 1, command_id: 'cmd-1', status: 'accepted', accepted_seq: 3 });
    expect(decodeActionReceipt(ACCEPTED_RECEIPT)).toEqual(decodeReceipt(ACCEPTED_RECEIPT));
    expect(() => decodeActionReceipt({ SchemaVersion: 2, CommandId: 'cmd-1', Status: 'accepted' }))
      .toThrow(ContractMismatchError);
    expect(() => decodeActionReceipt({ SchemaVersion: 1, CommandId: 'cmd-1', Status: 'mystery' }))
      .toThrow(ContractMismatchError);
  });
});
