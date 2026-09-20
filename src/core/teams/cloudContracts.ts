import { z } from 'zod';
import { canonicalTeamsJson, compareTeamsMaterialPaths, digestTeamsJson, isTeamsUnicodeScalarString } from './cloudCanonical.js';

/** Parsing validates data, never authority. Hosts must verify signed permits and persisted scope. */
export const TEAMS_NODE_VERSION = 'teams-node/v1' as const;
export const TEAMS_HOST_VERSION = 'teams-host/v1' as const;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_MATERIAL_BYTES = 64 * 1024 * 1024;
const MAX_REPORT_BYTES = 1024 * 1024;
const text = z.string().refine(isTeamsUnicodeScalarString, 'Invalid Unicode scalar string');
const length = (min: number, max: number) => text.refine(value => { const size = Array.from(value).length; return size >= min && size <= max; }, 'Invalid text length');
// Unicode White_Space, as used by Pydantic's Rust regex engine for Identifier.
const identifier = length(1, 256).refine(value => !Array.from(value).some(char => {
  const point = char.codePointAt(0)!;
  return (point >= 9 && point <= 13) || point === 32 || (point >= 0x2000 && point <= 0x200a)
    || [0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000].includes(point);
}), 'Identifier contains whitespace');
const operationKey = length(1, 200);
const digest = text.length(71).regex(/^sha256:[0-9a-f]{64}$/);
const commandId = text.length(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const revision = sequence.min(1);
const timestamp = text.refine(value => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || value.startsWith('0000')) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}, 'Expected a valid UTC timestamp with millisecond precision');

export type TeamsCloudJson = null | boolean | number | string | TeamsCloudJson[] | { [key: string]: TeamsCloudJson };
const json: z.ZodType<TeamsCloudJson> = z.lazy(() => z.union([z.null(), z.boolean(), text,
  z.number().refine(value => Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))),
  z.array(json), z.record(text, json),
]));
const objectPayload = z.record(text, json);
const nullableId = identifier.nullable().default(null);

export const teamsExecutionTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('node'), nodeId: identifier, nodeGeneration: revision }),
  z.strictObject({ kind: z.literal('cloud_agent'), agentId: identifier, versionId: identifier, runtimeId: identifier, agentInstanceId: identifier }),
]);
export const teamsExecutionRefSchema = z.strictObject({
  authorityId: identifier, groupId: identifier, teamRunId: identifier, memberId: identifier, runMemberId: identifier,
  taskId: nullableId, attemptId: identifier, deliveryId: identifier, bindingRef: identifier, providerRef: identifier,
  sessionId: identifier, commandId, idempotencyKey: operationKey, schedulerEpoch: revision, leaderEpoch: revision,
  dispatchEpoch: revision, attemptEpoch: revision, target: teamsExecutionTargetSchema,
  bundleDigest: digest, contractDigest: digest, capabilitiesDigest: digest, nativeRunId: nullableId,
});
export type TeamsExecutionRef = z.infer<typeof teamsExecutionRefSchema>;

export const teamsTerminalEvidenceSchema = z.strictObject({
  sessionId: identifier, runId: identifier, commandId, terminalSeq: sequence, terminalEventDigest: digest,
  resultDigest: digest.nullable().default(null),
});
const terminalStates = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
export const teamsHostReceiptSchema = z.strictObject({
  status: z.enum(['missing', 'accepted', 'duplicate', 'rejected', 'uncertain']), commandId, idempotencyKey: operationKey,
  payloadDigest: digest, storeIncarnation: identifier, runId: nullableId, acceptedSeq: sequence.nullable().default(null),
  nativeStatus: z.enum(['queued', 'running', 'waiting', 'awaiting_approval', 'waiting_for_node', 'succeeded', 'failed', 'cancelled', 'interrupted']).nullable().default(null),
  terminalEvidence: teamsTerminalEvidenceSchema.nullable().default(null),
}).superRefine((value, context) => {
  if (value.status === 'missing' && [value.runId, value.acceptedSeq, value.nativeStatus, value.terminalEvidence].some(item => item !== null)) {
    context.addIssue({ code: 'custom', message: 'Missing receipt cannot contain execution evidence' });
  }
  if (value.terminalEvidence && (value.commandId !== value.terminalEvidence.commandId || value.runId !== value.terminalEvidence.runId || !terminalStates.has(value.nativeStatus ?? ''))) {
    context.addIssue({ code: 'custom', message: 'Terminal evidence must match the original command/run and terminal status' });
  }
});
export type TeamsHostReceipt = z.infer<typeof teamsHostReceiptSchema>;

export const teamsCanonicalEventSchema = z.strictObject({
  eventId: identifier, sessionId: identifier, runId: identifier, seq: sequence, family: identifier, type: identifier,
  payload: objectPayload,
  sourceRef: z.strictObject({ nativeRunId: nullableId, parentRunId: nullableId, nativeEventType: nullableId }),
});
function boundedReport(value: unknown, context: z.RefinementCtx) {
  try {
    if (new TextEncoder().encode(canonicalTeamsJson(value)).byteLength <= MAX_REPORT_BYTES) return;
  } catch { /* An unsafe JSON value is never a valid bounded report. */ }
  context.addIssue({ code: 'custom', message: 'Report is not safe canonical JSON within one MiB' });
}
export const teamsCanonicalEventBatchSchema = z.strictObject({
  sessionId: identifier, storeIncarnation: identifier, afterSeq: sequence, nextSeq: sequence, snapshotUpperSeq: sequence,
  hasMore: z.boolean(), items: z.array(teamsCanonicalEventSchema).max(200),
}).superRefine((value, context) => {
  if (!(value.afterSeq <= value.nextSeq && value.nextSeq <= value.snapshotUpperSeq)
    || value.hasMore !== (value.nextSeq < value.snapshotUpperSeq)
    || (value.hasMore && value.nextSeq === value.afterSeq)) {
    context.addIssue({ code: 'custom', message: 'Invalid frozen canonical session cursor interval' });
  }
  let previous = value.afterSeq;
  const ids = new Set<string>();
  for (const item of value.items) {
    if (item.sessionId !== value.sessionId || !(previous < item.seq && item.seq <= value.nextSeq) || ids.has(item.eventId)) {
      context.addIssue({ code: 'custom', message: 'Events must be unique and ordered in the declared session interval' });
    }
    previous = item.seq; ids.add(item.eventId);
  }
  boundedReport(value, context);
});
export type TeamsCanonicalEventBatch = z.infer<typeof teamsCanonicalEventBatchSchema>;

const executionAuthorization = z.strictObject({ permitKind: z.enum(['execute', 'recovery']), permit: length(1, 16_384), grantRevision: revision.nullable().default(null) });
const nodeBase = {
  protocolVersion: z.literal(TEAMS_NODE_VERSION).default(TEAMS_NODE_VERSION), nodeCommandId: commandId,
  operationKey, ref: teamsExecutionRefSchema, commandDigest: digest, issuedAt: timestamp, claimLeaseUntil: timestamp,
  authorization: executionAuthorization,
};
const preparePayload = z.strictObject({ contextRef: identifier, contextDigest: digest, materialManifestRef: nullableId });

// Validate native shape without adding defaults or stripping forward-compatible fields.
// Its exact original dictionary remains in the node command digest and Host admission.
const nativeEnqueueShape = z.object({
  schema_version: z.literal(1).optional(), command_id: commandId, idempotency_key: z.string(), tenant_id: z.string(),
  agent_instance_id: z.string(), session_id: z.string(), command_type: z.literal('enqueue'),
  source: z.object({ kind: z.enum(['studio', 'responses', 'agui', 'a2a', 'parent_agent', 'scheduler', 'workflow', 'channel', 'system']), ref: z.string() }).passthrough(),
  authorization_ref: z.string(), submitted_at: z.string(), causation_id: z.string().nullable().optional(), correlation_id: z.string().nullable().optional(),
  payload: z.object({ content: json, reply_to: z.string().nullable().optional(), execution_grant_id: length(1, 512),
    execution_grant_attempt_epoch: revision.nullable().optional(), execution_policy_ref: length(1, Number.MAX_SAFE_INTEGER), teams_context_ref: length(1, Number.MAX_SAFE_INTEGER),
  }).passthrough(),
}).passthrough();
const submitPayload = z.strictObject({ command: objectPayload, payloadDigest: digest }).superRefine((value, context) => {
  if (!nativeEnqueueShape.safeParse(value.command).success) context.addIssue({ code: 'custom', message: 'Teams submit requires an original governed native enqueue envelope' });
});
const setGrantPayload = z.strictObject({
  grantId: identifier, expectedRevision: revision, state: z.enum(['active', 'suspended', 'revoked']), attemptEpoch: revision,
  expiresAt: timestamp, renewalId: operationKey.nullable().default(null), controlId: operationKey.nullable().default(null),
}).superRefine((value, context) => {
  if ((value.renewalId === null) === (value.controlId === null) || (value.renewalId !== null && value.state !== 'active')) {
    context.addIssue({ code: 'custom', message: 'Exactly one control or active renewal identity is required' });
  }
});
export const teamsNodeCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...nodeBase, operation: z.literal('prepare'), lane: z.literal('execution'), payload: preparePayload }),
  z.strictObject({ ...nodeBase, operation: z.literal('submit'), lane: z.literal('execution'), payload: submitPayload }),
  z.strictObject({ ...nodeBase, operation: z.literal('lookup'), lane: z.literal('control'), payload: z.strictObject({ commandId, idempotencyKey: operationKey, payloadDigest: digest, storeIncarnation: identifier }) }),
  z.strictObject({ ...nodeBase, operation: z.literal('set_grant'), lane: z.literal('control'), payload: setGrantPayload }),
  z.strictObject({ ...nodeBase, operation: z.literal('set_admission'), lane: z.literal('control'), payload: z.strictObject({ grantId: identifier, expectedAdmissionRevision: revision, admissionAllowed: z.boolean(), attemptEpoch: revision, controlId: operationKey }) }),
  z.strictObject({ ...nodeBase, operation: z.literal('get_grant'), lane: z.literal('control'), payload: z.strictObject({ grantId: identifier, renewalId: operationKey.nullable().default(null) }) }),
  z.strictObject({ ...nodeBase, operation: z.literal('cancel'), lane: z.literal('control'), payload: z.strictObject({ controlCommandId: commandId, controlIdempotencyKey: operationKey, targetRunId: identifier, reason: length(0, 2_000) }) }),
  z.strictObject({ ...nodeBase, operation: z.literal('respond_interaction'), lane: z.literal('control'), payload: z.strictObject({ controlCommandId: commandId, controlIdempotencyKey: operationKey, interactionId: identifier, expectedRevision: revision, action: z.enum(['approve', 'reject', 'submit', 'cancel']), response: objectPayload }) }),
  z.strictObject({ ...nodeBase, operation: z.literal('observe'), lane: z.literal('control'), payload: z.strictObject({ sessionId: identifier, afterSeq: sequence, limit: z.number().int().min(1).max(200).default(200) }) }),
]).superRefine((value, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  if (value.ref.target.kind !== 'node' || value.nodeCommandId === value.ref.commandId || value.claimLeaseUntil <= value.issuedAt) issue('Invalid node target, operation identity or claim interval');
  if (value.operation === 'submit' && (value.payload.command.command_id !== value.ref.commandId || value.payload.command.idempotency_key !== value.ref.idempotencyKey || value.payload.command.session_id !== value.ref.sessionId)) issue('Submit differs from frozen enqueue reference');
  if (value.operation === 'lookup' && (value.payload.commandId !== value.ref.commandId || value.payload.idempotencyKey !== value.ref.idempotencyKey)) issue('Lookup must target the original enqueue');
  if (value.operation === 'cancel' || value.operation === 'respond_interaction') {
    if ([value.nodeCommandId, value.ref.commandId].includes(value.payload.controlCommandId) || value.payload.controlIdempotencyKey === value.ref.idempotencyKey || value.ref.nativeRunId === null) issue('Control requires original native run and independent identity');
    if (value.operation === 'cancel' && value.payload.targetRunId !== value.ref.nativeRunId) issue('Cancel must target the exact original native run');
  }
  if (value.operation === 'observe' && value.payload.sessionId !== value.ref.sessionId) issue('Observe must target the original session');
  if (value.operation === 'set_admission' && (value.payload.attemptEpoch !== value.ref.attemptEpoch || value.payload.controlId === value.ref.idempotencyKey)) issue('Admission requires the original attempt and an independent control identity');
  const executes = ['prepare', 'submit', 'respond_interaction', 'set_admission'].includes(value.operation) || (value.operation === 'set_grant' && value.payload.state !== 'revoked');
  if (executes && value.authorization.permitKind !== 'execute') issue('Recovery authorization cannot grant execution');
});
export type TeamsNodeCommand = z.infer<typeof teamsNodeCommandSchema>;

export async function teamsNodeCommandDigest(value: TeamsNodeCommand): Promise<string> {
  const ref: Partial<TeamsExecutionRef> = { ...value.ref };
  delete ref.schedulerEpoch;
  return digestTeamsJson({ protocolVersion: value.protocolVersion, nodeCommandId: value.nodeCommandId,
    operationKey: value.operationKey, operation: value.operation, lane: value.lane, ref, payload: value.payload });
}
export async function parseTeamsNodeCommand(raw: unknown): Promise<TeamsNodeCommand> {
  const command = teamsNodeCommandSchema.parse(raw);
  if (await teamsNodeCommandDigest(command) !== command.commandDigest) throw new Error('node_command_digest_mismatch');
  return command;
}

const relativePath = text.refine(value => {
  if (!value || Array.from(value).length > 4_096 || value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/.test(value)) return false;
  if (Array.from(value).some(char => char.codePointAt(0)! < 32 || char.codePointAt(0) === 127)) return false;
  return value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}, 'Material path must be a normalized relative file path');
export const teamsMaterialEntrySchema = z.strictObject({ path: relativePath, digest, sizeBytes: z.number().int().min(0).max(MAX_FILE_BYTES), mediaType: length(1, 200) });
const materialShape = {
  kind: z.enum(['files', 'git_snapshot']), sourceCommit: text.refine(value => [40, 64].includes(value.length) && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)).nullable().default(null),
  entries: z.array(teamsMaterialEntrySchema).min(1).max(4_096),
};
function validateManifest(value: { kind: string; sourceCommit: string | null; entries: Array<{ path: string; sizeBytes: number }> }, context: z.RefinementCtx) {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  if ((value.kind === 'git_snapshot') !== (value.sourceCommit !== null)) issue('Only Git snapshots require a full source commit');
  if (value.entries.reduce((size, entry) => size + entry.sizeBytes, 0) > MAX_MATERIAL_BYTES) issue('Material exceeds 64 MiB');
  const paths = new Set(value.entries.map(entry => entry.path));
  if (paths.size !== value.entries.length) issue('Duplicate material path');
  for (const path of paths) {
    const parts = path.split('/'); parts.pop();
    while (parts.length) { if (paths.has(parts.join('/'))) issue('A material file cannot also be a directory'); parts.pop(); }
  }
}
export const teamsMaterialManifestSchema = z.strictObject(materialShape).superRefine(validateManifest);
export const teamsMaterialCreateSchema = z.strictObject({ ...materialShape, idempotencyKey: operationKey }).superRefine(validateManifest);
export type TeamsMaterialManifest = z.infer<typeof teamsMaterialManifestSchema>;
export type TeamsMaterialCreateInput = z.infer<typeof teamsMaterialCreateSchema>;
export async function teamsMaterialManifestDigest(raw: unknown): Promise<string> {
  const manifest = teamsMaterialManifestSchema.parse(raw);
  const value = { kind: manifest.kind, ...(manifest.sourceCommit === null ? {} : { sourceCommit: manifest.sourceCommit }),
    entries: [...manifest.entries].sort((a, b) => compareTeamsMaterialPaths(a.path, b.path)) };
  return digestTeamsJson(value);
}

export const teamsExecutionGrantSnapshotSchema = z.strictObject({
  storeIncarnation: identifier,
  grant: z.strictObject({ grantId: identifier, state: z.enum(['active', 'suspended', 'revoked']), revision, attemptEpoch: revision,
    expiresAt: timestamp, admissionAllowed: z.boolean(), admissionRevision: revision }),
  barrier: z.strictObject({
    queuedMessageIds: z.array(identifier).max(10_000).default([]), inFlightMessageIds: z.array(identifier).max(10_000).default([]),
    discardedMessageIds: z.array(identifier).max(10_000).default([]), settledMessageIds: z.array(identifier).max(10_000).default([]),
    commands: z.array(z.strictObject({ messageId: identifier, commandId, idempotencyKey: operationKey,
      inboxState: z.enum(['accepted', 'claimed', 'completed', 'discarded']), runId: nullableId,
      runState: z.enum(['pending', 'running', 'paused', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted']).nullable().default(null),
    })).max(10_000).default([]),
  }),
});
export const teamsGrantMutationReceiptSchema = z.strictObject({ operationId: operationKey, status: z.literal('applied').default('applied'), snapshot: teamsExecutionGrantSnapshotSchema });
const getGrantResult = z.strictObject({
  operation: z.literal('get_grant'), storeIncarnation: identifier, current: teamsExecutionGrantSnapshotSchema.nullable().default(null),
  lookupOperationId: operationKey.nullable().default(null), mutationReceipt: teamsGrantMutationReceiptSchema.nullable().default(null),
}).superRefine((value, context) => {
  if ((value.current && value.current.storeIncarnation !== value.storeIncarnation)
    || (value.mutationReceipt && (value.mutationReceipt.operationId !== value.lookupOperationId || value.mutationReceipt.snapshot.storeIncarnation !== value.storeIncarnation))) {
    context.addIssue({ code: 'custom', message: 'Grant lookup must match the original store and mutation identity' });
  }
});
export const teamsHostOperationResultSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('prepare'), contextRef: identifier, contextDigest: digest, snapshot: teamsExecutionGrantSnapshotSchema }),
  z.strictObject({ operation: z.literal('set_grant'), mutationReceipt: teamsGrantMutationReceiptSchema }),
  z.strictObject({ operation: z.literal('set_admission'), mutationReceipt: teamsGrantMutationReceiptSchema }),
  getGrantResult,
]);
export type TeamsExecutionGrantSnapshot = z.infer<typeof teamsExecutionGrantSnapshotSchema>;
export type TeamsGrantMutationReceipt = z.infer<typeof teamsGrantMutationReceiptSchema>;
export type TeamsHostOperationResult = z.infer<typeof teamsHostOperationResultSchema>;

/** Pre-execution probes deliberately carry no fabricated execution/run reference. */
export const teamsNodeProbeCommandSchema = z.strictObject({
  protocolVersion: z.literal(TEAMS_NODE_VERSION).default(TEAMS_NODE_VERSION),
  nodeCommandId: commandId, operation: z.literal('describe'), lane: z.literal('control').default('control'),
  operationKey, authorityId: identifier, nodeId: identifier, bindingRef: identifier, localBindingRef: identifier,
  expectedDigests: z.strictObject({ bundle: digest, contract: digest, capabilities: digest }),
  nodeGeneration: revision, claimLeaseUntil: timestamp,
  authorization: z.strictObject({ permitKind: z.literal('probe'), permit: length(1, 16384) }), commandDigest: digest,
});
export type TeamsNodeProbeCommand = z.infer<typeof teamsNodeProbeCommandSchema>;
export async function teamsNodeProbeDigest(raw: unknown): Promise<string> {
  const stable = Object.fromEntries(Object.entries(teamsNodeProbeCommandSchema.parse(raw)).filter(([key]) => !['authorization', 'claimLeaseUntil', 'commandDigest'].includes(key)));
  return digestTeamsJson(stable);
}
export async function parseTeamsNodeMessage(raw: unknown): Promise<TeamsNodeCommand | TeamsNodeProbeCommand> {
  if (raw && typeof raw === 'object' && 'operation' in raw && raw.operation === 'describe') {
    const command = teamsNodeProbeCommandSchema.parse(raw);
    if (await teamsNodeProbeDigest(command) !== command.commandDigest) throw new Error('node_probe_digest_mismatch');
    return command;
  }
  return parseTeamsNodeCommand(raw);
}
export const teamsNodeProbeResultSchema = z.strictObject({
  bindingRef: identifier, localBindingRef: identifier, agentInstanceId: identifier, storeIncarnation: identifier,
  capabilities: objectPayload, capabilitiesDigest: digest, bundleDigest: digest, contractDigest: digest,
});
export const teamsNodeProbeReportSchema = z.strictObject({
  reportKind: z.literal('probe').default('probe'), nodeCommandId: commandId, nodeGeneration: revision,
  commandDigest: digest, resultRevision: revision, phase: z.enum(['described', 'uncertain', 'rejected']),
  probeResult: teamsNodeProbeResultSchema.nullable().default(null),
  error: z.strictObject({ code: identifier, retryable: z.boolean() }).nullable().default(null),
}).refine(value => (value.phase === 'described') === (value.probeResult !== null), 'Described probe requires exact Host result');
export type TeamsNodeProbeResult = z.infer<typeof teamsNodeProbeResultSchema>;
export type TeamsNodeProbeReport = z.infer<typeof teamsNodeProbeReportSchema>;
export const decodeTeamsNodeProbeReport = (raw: unknown): TeamsNodeProbeReport => teamsNodeProbeReportSchema.parse(raw);

/** Structural validation; use decodeTeamsExecutionResult to also verify both JCS digests. */
export const teamsExecutionResultSchema = z.strictObject({
  status: z.enum(['succeeded', 'failed', 'cancelled', 'interrupted']),
  candidate: z.strictObject({ result: length(0, MAX_REPORT_BYTES), artifacts: z.array(objectPayload).max(1000).default([]) }),
  usage: z.strictObject({ totalTokens: sequence }), terminalEvidence: teamsTerminalEvidenceSchema, completionDigest: digest,
}).superRefine(boundedReport);
export type TeamsExecutionResult = z.infer<typeof teamsExecutionResultSchema>;
export async function decodeTeamsExecutionResult(raw: unknown): Promise<TeamsExecutionResult> {
  const value = teamsExecutionResultSchema.parse(raw);
  if (await digestTeamsJson(value.candidate) !== value.terminalEvidence.resultDigest) throw new Error('candidate_digest_mismatch');
  const { completionDigest, ...facts } = value;
  if (await digestTeamsJson(facts) !== completionDigest) throw new Error('completion_digest_mismatch');
  return value;
}

/** Structural validation; decodeTeamsNodeReport additionally verifies completion digests. */
export const teamsNodeReportSchema = z.strictObject({
  nodeCommandId: commandId, nodeGeneration: revision, commandDigest: digest, resultRevision: revision,
  phase: z.enum(['prepared', 'submitted', 'running', 'waiting', 'terminal', 'uncertain', 'rejected', 'control_applied']),
  receipt: teamsHostReceiptSchema.nullable().default(null), eventBatch: teamsCanonicalEventBatchSchema.nullable().default(null),
  materialProof: z.strictObject({ manifestRef: identifier, digest }).nullable().default(null),
  error: z.strictObject({ code: identifier, retryable: z.boolean() }).nullable().default(null),
  operationResult: teamsHostOperationResultSchema.nullable().default(null),
  executionResult: teamsExecutionResultSchema.nullable().default(null),
}).superRefine((value, context) => {
  if (value.phase === 'prepared' && value.operationResult?.operation !== 'prepare') context.addIssue({ code: 'custom', message: 'Prepared report requires durable preparation result' });
  if (value.phase === 'control_applied' && (!value.operationResult || value.operationResult.operation === 'prepare')) context.addIssue({ code: 'custom', message: 'Control report requires a typed mutation or lookup result' });
  if (value.operationResult !== null && !['prepared', 'control_applied'].includes(value.phase)) context.addIssue({ code: 'custom', message: 'Operation result only belongs to preparation or control reports' });
  if (value.phase === 'terminal' && !value.receipt?.terminalEvidence) context.addIssue({ code: 'custom', message: 'Terminal report requires canonical evidence' });
  if (value.phase === 'terminal' && (!value.executionResult || value.executionResult.status !== value.receipt?.nativeStatus
    || canonicalTeamsJson(value.executionResult.terminalEvidence) !== canonicalTeamsJson(value.receipt?.terminalEvidence ?? null))) context.addIssue({ code: 'custom', message: 'Terminal report requires matching canonical completion' });
  if (value.phase !== 'terminal' && value.executionResult !== null) context.addIssue({ code: 'custom', message: 'Completion only belongs to terminal report' });
  boundedReport(value, context);
});
export type TeamsNodeReport = z.infer<typeof teamsNodeReportSchema>;

export const decodeTeamsExecutionRef = (raw: unknown): TeamsExecutionRef => teamsExecutionRefSchema.parse(raw);
export const decodeTeamsHostReceipt = (raw: unknown): TeamsHostReceipt => teamsHostReceiptSchema.parse(raw);
export const decodeTeamsCanonicalEventBatch = (raw: unknown): TeamsCanonicalEventBatch => teamsCanonicalEventBatchSchema.parse(raw);
export const decodeTeamsMaterialManifest = (raw: unknown): TeamsMaterialManifest => teamsMaterialManifestSchema.parse(raw);
export const decodeTeamsNodeReport = async (raw: unknown): Promise<TeamsNodeReport> => {
  const value = teamsNodeReportSchema.parse(raw);
  if (value.executionResult) await decodeTeamsExecutionResult(value.executionResult);
  return value;
};
export const decodeTeamsHostOperationResult = (raw: unknown): TeamsHostOperationResult => teamsHostOperationResultSchema.parse(raw);

/** Reuse identical scalar rules in the additional frozen wire contracts. */
export const teamsCloudScalarSchemas = { text, length, identifier, operationKey, digest, commandId, sequence, revision, timestamp, relativePath };
