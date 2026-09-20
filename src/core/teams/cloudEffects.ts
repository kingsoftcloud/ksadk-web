import { z } from 'zod';
import { workspaceScopeSchema } from './workspaceContracts.js';

const id = z.string().min(1).max(256);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const cloudEffectOutcomeSchema = z.strictObject({
  phase: z.enum(['completed', 'failed']), external_ref: id.nullable(), evidence_ref: id,
  result_digest: digest.nullable(), definitively_not_applied: z.boolean(),
}).refine(value => (value.phase === 'failed') === value.definitively_not_applied, 'Unproven effect outcome');
export const cloudEffectResolutionSchema = z.strictObject({
  resolutionId: id, expectedRevision: revision, expectedEvidenceDigest: digest,
  decision: z.enum(['confirmed_applied', 'confirmed_not_applied', 'accept_risk']),
  evidenceRef: id, reason: z.string().min(1).max(1000),
  kind: z.enum(['manual_risk_acceptance', 'external_evidence']),
  actorSubject: id, ownerScopeRef: id, verifiedOutcome: cloudEffectOutcomeSchema.nullable(),
}).refine(value => value.decision === 'accept_risk'
  ? value.kind === 'manual_risk_acceptance' && value.verifiedOutcome === null
  : value.kind === 'external_evidence' && value.verifiedOutcome?.phase === (value.decision === 'confirmed_applied' ? 'completed' : 'failed'), 'Unverified effect resolution');
export const cloudEffectSchema = z.strictObject({
  effectKey: id, groupId: id, teamRunId: id, toolName: id,
  effectClass: z.enum(['external_idempotent', 'external_reconcilable']),
  phase: z.enum(['prepared', 'unknown', 'completed', 'failed', 'resolved']),
  revision, evidenceDigest: digest, resolution: cloudEffectResolutionSchema.nullable(),
  resolutionConflict: z.boolean(), outcome: cloudEffectOutcomeSchema.nullable(),
}).refine(value => value.phase === 'resolved' ? value.resolution !== null
  : value.resolution === null && !value.resolutionConflict && (['completed', 'failed'].includes(value.phase)
    ? value.outcome?.phase === value.phase : value.outcome === null), 'Inconsistent effect projection');
export type CloudEffect = z.infer<typeof cloudEffectSchema>;
export const cloudEffectPageSchema = z.strictObject({
  scope: workspaceScopeSchema, teamRunId: id, items: z.array(cloudEffectSchema).max(100),
  nextCursor: revision.nullable(),
}).refine(value => new Set(value.items.map(item => item.effectKey)).size === value.items.length, 'Duplicate effect identity');
export type CloudEffectPage = z.infer<typeof cloudEffectPageSchema>;
