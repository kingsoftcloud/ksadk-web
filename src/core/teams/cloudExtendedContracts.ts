/** Additional frozen Teams DTOs. Python exports the published JSON Schemas;
 * shared generated fixtures test these browser semantic decoders against them.
 * Decoding proves shape, never a permit signature or execution authorization.
 */
import { z } from 'zod';
import { compareTeamsMaterialPaths } from './cloudCanonical.js';
import { teamsCloudScalarSchemas as scalar, teamsExecutionRefSchema } from './cloudContracts.js';
import { cloudEffectSchema, cloudEffectPageSchema } from './cloudEffects.js';

export const TEAMS_EFFECTS_PORT_VERSION = 'teams-effects/v1' as const;
export const TEAMS_BUILD_VERSION = 'teams-build/v1' as const;
export const TEAMS_LOADED_BUILD_VERSION = 'teams-loaded-build/v1' as const;
const { identifier: id, operationKey, digest, revision, timestamp, commandId, relativePath, length } = scalar;
const phase = z.enum(['prepared', 'unknown', 'completed', 'failed', 'resolved']);
const effectClass = z.enum(['external_idempotent', 'external_reconcilable']);
export const teamsEffectRequestSchema = z.strictObject({
  ref: teamsExecutionRefSchema, context_ref: id, store_incarnation: id, journal_incarnation: id,
  native_run_id: id, tool_call_id: id, effect_index: z.number().int().min(0).max(1023),
  tool_name: id, adapter_version: id, effect_class: effectClass, payload_digest: digest,
}).refine(value => value.ref.nativeRunId === null || value.ref.nativeRunId === value.native_run_id, 'effect_native_run_mismatch');
export const teamsEffectOutcomeSchema = z.strictObject({
  phase: z.enum(['completed', 'failed']), external_ref: id.nullable().default(null), evidence_ref: id,
  result_digest: digest.nullable().default(null), definitively_not_applied: z.boolean().default(false),
}).refine(value => (value.phase === 'failed') === value.definitively_not_applied, 'effect_outcome_not_proven');
export const teamsEffectPreparedReceiptSchema = z.strictObject({
  effect_key: id, payload_digest: digest, request_digest: digest, revision, phase,
});
export const teamsEffectRecordSchema = z.strictObject({
  request: teamsEffectRequestSchema, phase: z.enum(['prepared', 'unknown', 'completed', 'failed']),
  revision, evidence_digest: digest, outcome: teamsEffectOutcomeSchema.nullable().default(null),
}).refine(value => ['completed', 'failed'].includes(value.phase)
  ? value.outcome?.phase === value.phase : value.outcome === null, 'effect_outcome_inconsistent');
export const teamsEffectReportReceiptSchema = z.strictObject({
  effectKey: id, journalRevision: revision, evidenceDigest: digest, authorityRevision: revision, phase,
});
export const teamsEffectReconcileInputSchema = z.strictObject({
  expectedRevision: revision, expectedEvidenceDigest: digest,
  decision: z.enum(['confirmed_applied', 'confirmed_not_applied', 'accept_risk']),
  evidenceRef: id, reason: length(1, 1000), idempotencyKey: operationKey,
});
const resolutionSchema = z.strictObject({
  resolutionId: id, expectedRevision: revision, expectedEvidenceDigest: digest,
  decision: z.enum(['confirmed_applied', 'confirmed_not_applied', 'accept_risk']), evidenceRef: id,
  reason: length(1, 1000), kind: z.enum(['manual_risk_acceptance', 'external_evidence']),
  actorSubject: id, ownerScopeRef: id, verifiedOutcome: teamsEffectOutcomeSchema.nullable(),
}).refine(value => value.decision === 'accept_risk'
  ? value.kind === 'manual_risk_acceptance' && value.verifiedOutcome === null
  : value.kind === 'external_evidence' && value.verifiedOutcome?.phase === (value.decision === 'confirmed_applied' ? 'completed' : 'failed'), 'effect_resolution_not_verified');
// Retain existing public projection invariants, with the shared code-point
// lengths/identifier rules instead of JavaScript UTF-16 length approximations.
export const teamsEffectProjectionSchema = cloudEffectSchema.safeExtend({
  effectKey: id, groupId: id, teamRunId: id, toolName: id,
  resolution: resolutionSchema.nullable(), outcome: teamsEffectOutcomeSchema.nullable(),
});
export const teamsEffectProjectionPageSchema = cloudEffectPageSchema.safeExtend({
  scope: z.strictObject({ authorityId: length(1, 256), ownerScopeRef: length(1, 512), groupId: length(1, 256) }),
  teamRunId: id, items: z.array(teamsEffectProjectionSchema).max(100),
});
export const teamsExecutionEffectsPageSchema = z.strictObject({
  contextRef: id, storeIncarnation: id, nativeRunId: id, journalIncarnation: id,
  items: z.array(teamsEffectRecordSchema).max(100), nextCursor: scalar.text.nullable().default(null),
});
const execute = new Set(['ensure_session', 'prepare', 'enqueue', 'renew_grant', 'set_grant', 'set_admission', 'invoke', 'respond_interaction']);
const recovery = new Set(['lookup', 'get_result', 'observe', 'get_grant', 'revoke', 'cancel']);
const executionPermitSchema = z.strictObject({
  schemaVersion: z.literal(1).default(1), issuer: id, kid: id, authorityId: id,
  issuedAt: timestamp, expiresAt: timestamp, nonce: id, signature: length(0, 128).default(''),
  audience: z.literal('agentengine-teams-runtime').default('agentengine-teams-runtime'),
  permitKind: z.enum(['execute', 'recovery']), subjectRef: id, agentInstanceId: id, sessionId: id,
  commandId, allowedOperations: z.array(scalar.text).min(1).max(16), payloadDigest: digest,
  policyDigest: digest, leaderEpoch: revision, dispatchEpoch: revision, attemptEpoch: revision, grantRevision: revision,
}).refine(value => { const ttl = Date.parse(value.expiresAt) - Date.parse(value.issuedAt); return ttl > 0 && ttl <= 60_000; }, 'invalid_permit_lifetime')
  .refine(value => new Set(value.allowedOperations).size === value.allowedOperations.length
    && value.allowedOperations.every(operation => (value.permitKind === 'execute' ? execute : recovery).has(operation)), 'invalid_permit_operations');
export const teamsExecutionEffectsRequestSchema = z.strictObject({
  contextRef: length(1, Number.MAX_SAFE_INTEGER), expectedIncarnation: length(1, Number.MAX_SAFE_INTEGER),
  permit: executionPermitSchema, after: length(0, 256).default(''), limit: z.number().int().min(1).max(100).default(100),
});

const descriptors = {
  agentDefinitionDigest: '.teams/agent-definition.json', toolsPolicyDigest: '.teams/tools-policy.json',
  behaviorConfigDigest: '.teams/behavior-config.json', dependencyLockDigest: '.teams/dependency.lock',
} as const;
const contentDigests = { agentDefinitionDigest: digest, toolsPolicyDigest: digest, dependencyLockDigest: digest, behaviorConfigDigest: digest };
export const teamsBuildManifestSchema = z.strictObject({
  schemaVersion: z.literal(TEAMS_BUILD_VERSION).default(TEAMS_BUILD_VERSION), entrypoint: relativePath,
  ...contentDigests, materialContractVersion: z.literal('materials/v1').default('materials/v1'),
  files: z.array(z.strictObject({ path: relativePath, digest, sizeBytes: z.number().int().min(0).max(20 * 1024 * 1024) })).min(1).max(4096),
}).superRefine((value, context) => {
  const files = new Map(value.files.map(file => [file.path, file]));
  const paths = value.files.map(file => file.path);
  const valid = files.size === paths.length && !files.has('.teams/build-manifest.json')
    && paths.every((path, index) => index === 0 || compareTeamsMaterialPaths(paths[index - 1], path) < 0)
    && files.has(value.entrypoint) && !value.entrypoint.startsWith('.teams/')
    && value.files.reduce((total, file) => total + file.sizeBytes, 0) <= 64 * 1024 * 1024
    && Object.entries(descriptors).every(([field, path]) => files.get(path)?.digest === value[field as keyof typeof descriptors])
    && paths.every(path => path.split('/').every((_, index, parts) => index === 0 || !files.has(parts.slice(0, index).join('/'))));
  if (!valid) context.addIssue({ code: 'custom', message: 'invalid_build_manifest' });
});
export const teamsLoadedBuildEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(TEAMS_LOADED_BUILD_VERSION).default(TEAMS_LOADED_BUILD_VERSION),
  codeArtifactDigest: digest, buildManifestDigest: digest, ...contentDigests,
  materialContractVersion: z.literal('materials/v1').default('materials/v1'),
  immutableWorkspace: z.literal(true), externalMutableInputs: z.literal(false),
});
export const teamsBuildArtifactReceiptSchema = z.strictObject({
  buildArtifactRef: id, state: z.literal('verified'), authorityId: id,
  codeArtifactDigest: digest, buildManifestDigest: digest,
  sizeBytes: z.number().int().min(1).max(20 * 1024 * 1024), manifest: teamsBuildManifestSchema,
});
export const teamsBuildArtifactLookupInputSchema = z.strictObject({ idempotencyKey: operationKey });
export const teamsBuildArtifactLookupResultSchema = z.union([
  z.strictObject({ status: z.literal('missing') }),
  teamsBuildArtifactReceiptSchema.extend({ status: z.literal('recorded') }),
]);
export const teamsDeploymentArtifactReceiptSchema = z.strictObject({
  agentId: id, versionId: id, instanceId: id, codeArtifactDigest: digest, buildManifestDigest: digest,
  bundleDigest: digest, contractDigest: digest, deployedAt: scalar.text,
});
export const teamsReleaseVerifyInputSchema = z.strictObject({
  buildArtifactRef: id, localBindingRef: id, cloudBindingRef: id, idempotencyKey: operationKey,
});
export const teamsReleaseVerificationReceiptSchema = z.strictObject({
  releaseRef: id, buildArtifactRef: id, localBindingRef: id, cloudBindingRef: id, evidenceDigest: digest, verifiedAt: timestamp,
});

export const teamsExtendedContractSchemas = {
  'effect-request': teamsEffectRequestSchema, 'effect-outcome': teamsEffectOutcomeSchema,
  'effect-prepared-receipt': teamsEffectPreparedReceiptSchema, 'effect-record': teamsEffectRecordSchema,
  'effect-report-receipt': teamsEffectReportReceiptSchema, 'effect-reconcile-input': teamsEffectReconcileInputSchema,
  'effect-projection': teamsEffectProjectionSchema, 'effect-projection-page': teamsEffectProjectionPageSchema,
  'execution-effects-request': teamsExecutionEffectsRequestSchema, 'execution-effects-page': teamsExecutionEffectsPageSchema,
  'build-manifest': teamsBuildManifestSchema, 'loaded-build-evidence': teamsLoadedBuildEvidenceSchema,
  'build-artifact-receipt': teamsBuildArtifactReceiptSchema, 'build-artifact-lookup-input': teamsBuildArtifactLookupInputSchema,
  'build-artifact-lookup-result': teamsBuildArtifactLookupResultSchema, 'deployment-artifact-receipt': teamsDeploymentArtifactReceiptSchema,
  'release-verify-input': teamsReleaseVerifyInputSchema, 'release-verification-receipt': teamsReleaseVerificationReceiptSchema,
} as const;
export function decodeTeamsExtendedContract(model: string, value: unknown): unknown {
  if (!Object.hasOwn(teamsExtendedContractSchemas, model)) throw new Error('unknown_teams_contract');
  return teamsExtendedContractSchemas[model as keyof typeof teamsExtendedContractSchemas].parse(value);
}
export type TeamsBuildManifest = z.infer<typeof teamsBuildManifestSchema>;
export type TeamsLoadedBuildEvidence = z.infer<typeof teamsLoadedBuildEvidenceSchema>;
export type TeamsReleaseVerificationReceipt = z.infer<typeof teamsReleaseVerificationReceiptSchema>;
export type TeamsEffectRecord = z.infer<typeof teamsEffectRecordSchema>;
