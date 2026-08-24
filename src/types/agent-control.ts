/**
 * agent-kernel/v1 contract types and strict decoders.
 *
 * Hand-written from the canonical JSON schemas in
 * `contracts/agent-kernel/v1/` (aggregate digest
 * 69771d8df4a8811ed6623f26a152c869cfdfd8dbfdcad443b52a9b6403b267e8).
 *
 * Decoding rules:
 * - Required fields and enumerated values are validated strictly; a mismatch
 *   throws {@link ContractMismatchError} and callers must stop mutating state.
 * - Unknown optional fields are preserved in `extensions` for forward
 *   compatibility instead of being dropped silently.
 */
import { z } from 'zod';

export class ContractMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractMismatchError';
  }
}

// ---------------------------------------------------------------------------
// AgentControlReceipt/v1
// ---------------------------------------------------------------------------

export type AgentControlCommandType =
  | 'enqueue' | 'steer' | 'inject' | 'interrupt'
  | 'pause' | 'resume' | 'submit_interaction';

export type AgentControlReceiptStatus =
  | 'accepted' | 'duplicate' | 'rejected' | 'unsupported'
  | 'queue_full' | 'persistence_uncertain';

export type AgentControlError = {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  extensions: Record<string, unknown>;
};

export type AgentControlReceipt = {
  schema_version: 1;
  command_id: string;
  status: AgentControlReceiptStatus;
  message_id?: string | null;
  run_id?: string | null;
  accepted_seq?: number | null;
  error?: AgentControlError | null;
  /** Unknown optional fields kept verbatim. */
  extensions: Record<string, unknown>;
};

const RECEIPT_KNOWN_KEYS = new Set([
  'schema_version', 'command_id', 'status', 'message_id', 'run_id',
  'accepted_seq', 'error',
]);

const controlErrorShape = z.object({
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export function decodeReceipt(raw: unknown): AgentControlReceipt {
  const parsed = z
    .object({
      schema_version: z.literal(1),
      command_id: z.string().min(1),
      status: z.enum([
        'accepted', 'duplicate', 'rejected', 'unsupported',
        'queue_full', 'persistence_uncertain',
      ]),
      message_id: z.string().min(1).nullable().optional(),
      run_id: z.string().min(1).nullable().optional(),
      accepted_seq: z.number().int().min(0).nullable().optional(),
      error: controlErrorShape.nullable().optional(),
    })
    .passthrough()
    .safeParse(raw);
  if (!parsed.success) {
    throw new ContractMismatchError(
      `AgentControlReceipt/v1 mismatch: ${parsed.error.message}`,
    );
  }
  const value = parsed.data;
  if (
    (value.status === 'rejected'
      || value.status === 'unsupported'
      || value.status === 'queue_full'
      || value.status === 'persistence_uncertain')
    && !value.error
  ) {
    throw new ContractMismatchError(
      `AgentControlReceipt/v1 mismatch: status ${value.status} requires error`,
    );
  }
  const extensions: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!RECEIPT_KNOWN_KEYS.has(key)) {
      extensions[key] = entry;
    }
  }
  const error = value.error
    ? { ...value.error, extensions: {} as Record<string, unknown> }
    : null;
  return {
    schema_version: 1,
    command_id: value.command_id,
    status: value.status,
    message_id: value.message_id ?? null,
    run_id: value.run_id ?? null,
    accepted_seq: value.accepted_seq ?? null,
    error,
    extensions,
  };
}

// ---------------------------------------------------------------------------
// RuntimeCapabilityMatrix/v1
// ---------------------------------------------------------------------------

export type RuntimeCapabilityMode = 'native' | 'emulated' | 'unavailable';

export type RuntimeCapability = {
  supported: boolean;
  mode: RuntimeCapabilityMode;
  reason?: string | null;
  extensions: Record<string, unknown>;
};

export type RuntimeCapabilityMatrix = {
  schema_version: 1;
  cancel: RuntimeCapability;
  pause: RuntimeCapability;
  resume: RuntimeCapability;
  submit_interaction: RuntimeCapability;
  attach: RuntimeCapability;
  steer: RuntimeCapability;
  inject: RuntimeCapability;
  checkpoint: RuntimeCapability;
  durable_restore: RuntimeCapability;
  /** Runtime v2 execution modes are additive and absent on legacy runtimes. */
  goal?: RuntimeCapability;
  loop?: RuntimeCapability;
  plan?: RuntimeCapability;
  extensions: Record<string, unknown>;
};

const CAPABILITY_KEYS = [
  'cancel', 'pause', 'resume', 'submit_interaction', 'attach',
  'steer', 'inject', 'checkpoint', 'durable_restore',
] as const;

const EXECUTION_MODE_KEYS = ['goal', 'loop', 'plan'] as const;

const capabilityValue = z
  .object({
    supported: z.boolean(),
    mode: z.enum(['native', 'emulated', 'unavailable']),
    reason: z.string().min(1).nullable().optional(),
  })
  .passthrough();

function decodeCapability(raw: unknown, field: string): RuntimeCapability {
  const parsed = capabilityValue.safeParse(raw);
  if (!parsed.success) {
    throw new ContractMismatchError(
      `RuntimeCapabilityMatrix/v1 mismatch at ${field}: ${parsed.error.message}`,
    );
  }
  const value = parsed.data;
  if (!value.supported && (value.mode !== 'unavailable' || !value.reason)) {
    throw new ContractMismatchError(
      `RuntimeCapabilityMatrix/v1 mismatch at ${field}: unsupported capability requires mode=unavailable and reason`,
    );
  }
  const { supported, mode, reason, ...rest } = value;
  return {
    supported,
    mode,
    reason: reason ?? null,
    extensions: rest as Record<string, unknown>,
  };
}

export function decodeCapabilityMatrix(raw: unknown): RuntimeCapabilityMatrix {
  const base = z
    .object({
      schema_version: z.literal(1),
      ...Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, z.unknown()])),
    })
    .passthrough()
    .safeParse(raw);
  if (!base.success) {
    throw new ContractMismatchError(
      `RuntimeCapabilityMatrix/v1 mismatch: ${base.error.message}`,
    );
  }
  const value = base.data as Record<string, unknown>;
  const extensions: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (
      key !== 'schema_version'
      && !(CAPABILITY_KEYS as readonly string[]).includes(key)
      && !(EXECUTION_MODE_KEYS as readonly string[]).includes(key)
    ) {
      extensions[key] = value[key];
    }
  }
  const matrix: RuntimeCapabilityMatrix = {
    schema_version: 1,
    extensions,
  } as RuntimeCapabilityMatrix;
  for (const key of CAPABILITY_KEYS) {
    matrix[key] = decodeCapability(value[key], key);
  }
  for (const key of EXECUTION_MODE_KEYS) {
    if (value[key] !== undefined && value[key] !== null) {
      matrix[key] = decodeCapability(value[key], key);
    }
  }
  return matrix;
}

// ---------------------------------------------------------------------------
// SessionEventEnvelope/v1
// ---------------------------------------------------------------------------

export type SessionEventFamily =
  | 'control' | 'runtime' | 'workflow' | 'schedule' | 'job' | 'relationship';

export type SessionEventEnvelope = {
  schema_version: 1;
  event_id: string;
  session_id: string;
  seq: number;
  timestamp: string;
  family: string;
  family_version: number;
  event_type: string;
  payload: Record<string, unknown>;
  run_id?: string | null;
  causation_id?: string | null;
  correlation_id?: string | null;
  actor_ref?: string | null;
  extensions: Record<string, unknown>;
};

export type DecodedSessionEventEnvelope =
  | { ok: true; value: SessionEventEnvelope }
  | { ok: false; error: ContractMismatchError };

const ENVELOPE_KNOWN_KEYS = new Set([
  'schema_version', 'event_id', 'session_id', 'seq', 'timestamp',
  'family', 'family_version', 'event_type', 'payload', 'run_id',
  'causation_id', 'correlation_id', 'actor_ref',
]);

const KNOWN_FAMILIES: ReadonlyMap<string, number> = new Map([
  ['control', 1],
  ['runtime', 2],
]);

const envelopeSchema = z
  .object({
    schema_version: z.literal(1),
    event_id: z.string().min(1),
    session_id: z.string().min(1),
    seq: z.number().int().min(0),
    timestamp: z.string().min(1),
    family: z.string().min(1),
    family_version: z.number().int().min(1),
    event_type: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
    run_id: z.string().min(1).nullable().optional(),
    causation_id: z.string().min(1).nullable().optional(),
    correlation_id: z.string().min(1).nullable().optional(),
    actor_ref: z.string().min(1).nullable().optional(),
  })
  .passthrough();

/**
 * Decode a session event envelope. Unknown families decode successfully so
 * the cursor can still advance; only structural violations fail.
 */
export function decodeSessionEventEnvelope(raw: unknown): DecodedSessionEventEnvelope {
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: new ContractMismatchError(
        `SessionEventEnvelope/v1 mismatch: ${parsed.error.message}`,
      ),
    };
  }
  const value = parsed.data;
  const expectedVersion = KNOWN_FAMILIES.get(value.family);
  if (expectedVersion !== undefined && value.family_version !== expectedVersion) {
    return {
      ok: false,
      error: new ContractMismatchError(
        `SessionEventEnvelope/v1 mismatch: family ${value.family} requires family_version ${expectedVersion}`,
      ),
    };
  }
  const extensions: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!ENVELOPE_KNOWN_KEYS.has(key)) {
      extensions[key] = entry;
    }
  }
  return {
    ok: true,
    value: {
      schema_version: 1,
      event_id: value.event_id,
      session_id: value.session_id,
      seq: value.seq,
      timestamp: value.timestamp,
      family: value.family,
      family_version: value.family_version,
      event_type: value.event_type,
      payload: value.payload,
      run_id: value.run_id ?? null,
      causation_id: value.causation_id ?? null,
      correlation_id: value.correlation_id ?? null,
      actor_ref: value.actor_ref ?? null,
      extensions,
    },
  };
}

// ---------------------------------------------------------------------------
// AgentStatusSnapshot/v1
// ---------------------------------------------------------------------------

export type AgentStatusSnapshot = {
  schema_version: 1;
  agent_instance_id: string;
  instance_state: 'ready' | 'degraded' | 'unavailable';
  session_id?: string | null;
  active_run_id?: string | null;
  active_run_state?: 'pending' | 'running' | 'paused' | 'waiting' | null;
  inbox_depth: number;
  activation_id?: string | null;
  lease_expires_at?: string | null;
  capability: RuntimeCapabilityMatrix;
  extensions: Record<string, unknown>;
};

export function decodeAgentStatusSnapshot(raw: unknown): AgentStatusSnapshot {
  const parsed = z
    .object({
      schema_version: z.literal(1),
      agent_instance_id: z.string().min(1),
      instance_state: z.enum(['ready', 'degraded', 'unavailable']),
      session_id: z.string().min(1).nullable().optional(),
      active_run_id: z.string().min(1).nullable().optional(),
      active_run_state: z
        .enum(['pending', 'running', 'paused', 'waiting'])
        .nullable()
        .optional(),
      inbox_depth: z.number().int().min(0),
      activation_id: z.string().min(1).nullable().optional(),
      lease_expires_at: z.string().min(1).nullable().optional(),
      capability: z.unknown(),
    })
    .passthrough()
    .safeParse(raw);
  if (!parsed.success) {
    throw new ContractMismatchError(
      `AgentStatusSnapshot/v1 mismatch: ${parsed.error.message}`,
    );
  }
  const value = parsed.data;
  const extensions: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!['schema_version', 'agent_instance_id', 'instance_state', 'session_id',
      'active_run_id', 'active_run_state', 'inbox_depth', 'activation_id',
      'lease_expires_at', 'capability'].includes(key)) {
      extensions[key] = (value as Record<string, unknown>)[key];
    }
  }
  return {
    schema_version: 1,
    agent_instance_id: value.agent_instance_id,
    instance_state: value.instance_state,
    session_id: value.session_id ?? null,
    active_run_id: value.active_run_id ?? null,
    active_run_state: value.active_run_state ?? null,
    inbox_depth: value.inbox_depth,
    activation_id: value.activation_id ?? null,
    lease_expires_at: value.lease_expires_at ?? null,
    capability: decodeCapabilityMatrix(value.capability),
    extensions,
  };
}
