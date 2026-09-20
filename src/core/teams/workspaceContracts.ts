import { z } from 'zod';
import { canonicalTeamsJson } from './cloudCanonical.js';
import { TeamsError } from './contracts.js';
import { TEAMS_API_VERSION } from './types.js';

export const TEAMS_WORKSPACE_VERSION = 'workspace/v1' as const;
export const WORKSPACE_COLLECTIONS = ['runSummaries', 'taskSummaries', 'pendingInteractions', 'recentMessages', 'artifactSummaries'] as const;
export type WorkspaceCollection = typeof WORKSPACE_COLLECTIONS[number];
const id = z.string().min(1).max(256);
const seq = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const revision = seq.min(1);
const timestamp = z.iso.datetime({ offset: true }).max(40).refine(value => !value.startsWith('0000') && Number.isFinite(Date.parse(value)), 'Invalid timestamp');
const nullableId = id.nullable();
const reason = z.string().max(2_000).nullable();
const cursor = z.string().min(1).max(4_096).nullable();
const teamStatus = z.enum(['planning', 'running', 'waiting', 'needs_attention', 'awaiting_acceptance', 'succeeded', 'failed', 'cancel_requested', 'cancelled']);
const taskStatus = z.enum(['draft', 'ready', 'blocked', 'running', 'awaiting_acceptance', 'succeeded', 'failed', 'cancel_requested', 'cancelled']);
export const workspaceScopeSchema = z.strictObject({ authorityId: id, ownerScopeRef: z.string().min(1).max(512), groupId: id });
export type WorkspaceScope = z.infer<typeof workspaceScopeSchema>;
export type WorkspaceClientScope = WorkspaceScope & { origin: string };
export const workspaceClientScopeSchema = workspaceScopeSchema.extend({ origin: z.string().refine(value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && url.origin === value; } catch { return false; }
}, 'Invalid workspace origin') });
export const workspaceGroupSchema = z.strictObject({
  groupId: id, name: z.string().min(1).max(256), authorityRef: id, tenantId: id, ownerSubject: id,
  leaderMemberId: id, revision, status: z.enum(['active', 'archived']), createdAt: timestamp, updatedAt: timestamp,
  policy: z.strictObject({ taskAcceptance: z.enum(['leader', 'human', 'result']), peerWake: z.boolean() }),
});
const capabilities = z.strictObject({ enqueue: z.boolean(), cancel: z.boolean(), steer: z.boolean(), restore: z.boolean(), interaction: z.boolean(), leader: z.boolean() });
export const workspaceBindingSchema = z.strictObject({
  bindingRef: id, providerRef: id, kind: z.enum(['local_build', 'a2a', 'cloud']), agentId: id,
  capabilities, availability: z.strictObject({ state: z.enum(['ready', 'unchecked', 'unavailable']), code: nullableId, reason, action: z.string().max(256).nullable() }),
});
export const workspaceMemberSchema = z.strictObject({
  memberId: id, groupId: id, name: z.string().min(1).max(256), role: z.enum(['leader', 'member']), responsibility: z.string().max(2_000),
  bindingRef: id, binding: workspaceBindingSchema, sessionId: id, revision, status: z.enum(['active', 'removed', 'unavailable']),
  executionStatus: z.enum(['idle', 'queued', 'running', 'waiting', 'needs_attention', 'unavailable']), activeRunId: nullableId, reason,
}).refine(value => value.bindingRef === value.binding.bindingRef, 'Binding identity mismatch');
export const workspaceRunMemberSchema = workspaceMemberSchema.safeExtend({ runMemberId: id, teamRunId: id, groupRevision: revision });
export const workspaceLeaderStandbySchema = z.strictObject({
  state: z.enum(['armed', 'fencing_old', 'waiting_old_grant', 'activating', 'active', 'blocked']),
  standbyBindingRef: id, releaseRef: id, takeoverId: nullableId, reason, newLeaderEpoch: revision.nullable(),
});
export type WorkspaceLeaderStandby = z.infer<typeof workspaceLeaderStandbySchema>;
export const workspaceRunSummarySchema = z.strictObject({
  teamRunId: id, groupId: id, revision, groupRevision: revision, goalMessageId: id, goal: z.string(),
  leaderMemberId: id, status: teamStatus, dispatchSuspended: z.boolean(), dispatchEpoch: revision,
  taskCount: seq, pendingCount: seq, createdAt: timestamp, updatedAt: timestamp, reason,
  leaderStandby: workspaceLeaderStandbySchema.optional(),
});
export const workspaceTaskSummarySchema = z.strictObject({
  taskId: id, groupId: id, teamRunId: id, revision, title: z.string().min(1).max(2_000), ownerMemberId: nullableId,
  dependencies: z.array(id).max(4_096), status: taskStatus, attemptCount: seq, reason,
}).refine(value => new Set(value.dependencies).size === value.dependencies.length && !value.dependencies.includes(value.taskId), 'Invalid task dependencies');
const memberSource = z.strictObject({ authorityRef: id, groupId: id, memberId: id, bindingRef: id, providerRef: id, sessionId: id, runId: id, itemId: id.optional() });
const interactionRef = memberSource.extend({ interactionId: id });
export const workspaceInteractionSchema = z.strictObject({
  ref: interactionRef, groupId: id, teamRunId: id, revision, title: z.string().max(2_000),
  kind: z.enum(['approval', 'input']), status: z.enum(['pending', 'resolving', 'resolved', 'cancelled', 'expired']), createdAt: timestamp,
});
const part = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), text: z.string() }),
  z.strictObject({ kind: z.literal('attachment'), attachmentRef: id, mediaType: z.string().min(1).max(200), name: z.string().max(4_096).optional() }),
]);
export const workspaceMessageSchema = z.strictObject({
  messageId: id, groupId: id, teamRunId: nullableId, revision, createdSeq: revision, createdAt: timestamp,
  senderPrincipal: id, senderName: z.string().max(256), groupRole: z.enum(['owner', 'leader', 'member', 'system']), memberId: nullableId,
  parts: z.array(part).max(64), mentions: z.array(id).max(8), intent: z.enum(['start_goal', 'followup', 'directed', 'note', 'result', 'progress']),
  replyTo: nullableId, sourceRefs: z.array(memberSource).max(64), visibility: z.enum(['public', 'internal']),
});
export const workspaceArtifactSchema = z.strictObject({
  artifactId: id, groupId: id, teamRunId: id, revision, name: z.string().max(4_096), mediaType: z.string().min(1).max(200),
  source: memberSource, digest: z.string().regex(/^sha256:[0-9a-f]{64}$/).length(71), sizeBytes: seq,
  state: z.enum(['pending', 'ready', 'failed']),
});
export type WorkspaceGroup = z.infer<typeof workspaceGroupSchema>;
export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;
export type WorkspaceRunMember = z.infer<typeof workspaceRunMemberSchema>;
export type WorkspaceRunSummary = z.infer<typeof workspaceRunSummarySchema>;
export type WorkspaceTaskSummary = z.infer<typeof workspaceTaskSummarySchema>;
export type WorkspaceInteraction = z.infer<typeof workspaceInteractionSchema>;
export type WorkspaceMessage = z.infer<typeof workspaceMessageSchema>;
export type WorkspaceArtifact = z.infer<typeof workspaceArtifactSchema>;
export type WorkspaceRow = WorkspaceRunSummary | WorkspaceTaskSummary | WorkspaceInteraction | WorkspaceMessage | WorkspaceArtifact;

function bound(value: unknown, context: z.RefinementCtx) {
  try { if (new TextEncoder().encode(canonicalTeamsJson(value)).byteLength <= 2 * 1024 * 1024) return; } catch { /* Unsafe wire JSON. */ }
  context.addIssue({ code: 'custom', message: 'Workspace response exceeds safe JSON / two MiB boundary' });
}
export function workspaceScopeKey(scope: WorkspaceScope): string { return JSON.stringify([scope.authorityId, scope.ownerScopeRef, scope.groupId]); }
export function workspaceClientScopeKey(scope: WorkspaceClientScope): string { return JSON.stringify([scope.origin, workspaceScopeKey(scope)]); }
export function workspaceInteractionKey(value: WorkspaceInteraction): string {
  const ref = value.ref;
  return JSON.stringify([ref.authorityRef, ref.groupId, ref.memberId, ref.bindingRef, ref.providerRef, ref.sessionId, ref.runId, ref.interactionId]);
}
export function workspaceRowKey(collection: WorkspaceCollection, value: WorkspaceRow): string {
  switch (collection) {
    case 'runSummaries': return (value as WorkspaceRunSummary).teamRunId;
    case 'taskSummaries': return (value as WorkspaceTaskSummary).taskId;
    case 'pendingInteractions': return workspaceInteractionKey(value as WorkspaceInteraction);
    case 'recentMessages': return (value as WorkspaceMessage).messageId;
    case 'artifactSummaries': return (value as WorkspaceArtifact).artifactId;
  }
}
function scoped(row: { groupId: string; ref?: { groupId: string; authorityRef: string }; source?: { groupId: string; authorityRef: string }; sourceRefs?: Array<{ groupId: string; authorityRef: string }> }, scope: WorkspaceScope): boolean {
  return row.groupId === scope.groupId && [...(row.ref ? [row.ref] : []), ...(row.source ? [row.source] : []), ...(row.sourceRefs ?? [])]
    .every(ref => ref.groupId === scope.groupId && ref.authorityRef === scope.authorityId);
}
function validateRows(collection: WorkspaceCollection, rows: WorkspaceRow[], scope: WorkspaceScope, selectedRunId: string | null, context: z.RefinementCtx) {
  const keys = new Set<string>();
  for (const row of rows) {
    const key = workspaceRowKey(collection, row);
    if (keys.has(key) || !scoped(row, scope)) context.addIssue({ code: 'custom', message: 'Duplicate row or foreign workspace scope' });
    keys.add(key);
    if (collection !== 'runSummaries' && row.teamRunId !== selectedRunId) context.addIssue({ code: 'custom', message: 'Collection belongs to another selected run' });
    if (collection === 'pendingInteractions' && !['pending', 'resolving'].includes((row as WorkspaceInteraction).status)) context.addIssue({ code: 'custom', message: 'Pending collection contains a terminal interaction' });
  }
  if (collection === 'recentMessages' && rows.some((row, index) => index > 0 && (rows[index - 1] as WorkspaceMessage).createdSeq >= (row as WorkspaceMessage).createdSeq)) context.addIssue({ code: 'custom', message: 'Message history must be ordered by creation sequence' });
}
const cursors = z.strictObject({ runSummaries: cursor, taskSummaries: cursor, pendingInteractions: cursor, recentMessages: cursor, artifactSummaries: cursor });
export const teamWorkspaceSnapshotSchema = z.strictObject({
  apiVersion: z.literal(TEAMS_API_VERSION), viewVersion: z.literal(TEAMS_WORKSPACE_VERSION), scope: workspaceScopeSchema,
  snapshotId: id, watermark: seq, group: workspaceGroupSchema, members: z.array(workspaceMemberSchema).max(8),
  runSummaries: z.array(workspaceRunSummarySchema).max(20), selectedRun: workspaceRunSummarySchema.nullable(),
  selectedRunMembers: z.array(workspaceRunMemberSchema).max(8), taskSummaries: z.array(workspaceTaskSummarySchema).max(100),
  pendingInteractions: z.array(workspaceInteractionSchema).max(50), recentMessages: z.array(workspaceMessageSchema).max(50),
  artifactSummaries: z.array(workspaceArtifactSchema).max(50), cursors,
}).superRefine((value, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  if (value.group.groupId !== value.scope.groupId || value.group.authorityRef !== value.scope.authorityId) issue('Group scope mismatch');
  if (new Set(value.members.map(row => row.memberId)).size !== value.members.length || value.members.some(row => !scoped(row, value.scope))) issue('Invalid group roster');
  if (!value.members.some(row => row.memberId === value.group.leaderMemberId)) issue('Missing group Leader');
  const selectedId = value.selectedRun?.teamRunId ?? null;
  for (const collection of WORKSPACE_COLLECTIONS) validateRows(collection, value[collection], value.scope, selectedId, context);
  if (value.selectedRun && (!scoped(value.selectedRun, value.scope) || !value.selectedRunMembers.some(row => row.memberId === value.selectedRun!.leaderMemberId))) issue('Invalid selected run or frozen Leader roster');
  const selectedSummary = value.runSummaries.find(row => row.teamRunId === selectedId);
  if (selectedSummary && canonicalTeamsJson(selectedSummary) !== canonicalTeamsJson(value.selectedRun)) issue('Selected run and summary differ at snapshot watermark');
  if (new Set(value.selectedRunMembers.map(row => row.runMemberId)).size !== value.selectedRunMembers.length || new Set(value.selectedRunMembers.map(row => row.memberId)).size !== value.selectedRunMembers.length
    || value.selectedRunMembers.some(row => !scoped(row, value.scope) || row.teamRunId !== selectedId || row.groupRevision !== value.selectedRun?.groupRevision)) issue('Invalid frozen run roster');
  if (selectedId === null && (value.selectedRunMembers.length || WORKSPACE_COLLECTIONS.slice(1).some(collection => value[collection].length || value.cursors[collection] !== null))) issue('Unselected view cannot contain run-specific rows');
  if (value.recentMessages.some(row => row.createdSeq > value.watermark)) issue('Message creation is newer than snapshot watermark');
  bound(value, context);
});
export type TeamWorkspaceSnapshot = z.infer<typeof teamWorkspaceSnapshotSchema>;

const pageBase = { apiVersion: z.literal(TEAMS_API_VERSION), viewVersion: z.literal(TEAMS_WORKSPACE_VERSION), scope: workspaceScopeSchema,
  snapshotId: id, watermark: seq, teamRunId: nullableId, cursor: z.string().min(1).max(4_096), nextCursor: cursor };
export const workspacePageSchema = z.discriminatedUnion('collection', [
  z.strictObject({ ...pageBase, collection: z.literal('runSummaries'), items: z.array(workspaceRunSummarySchema).max(100) }),
  z.strictObject({ ...pageBase, collection: z.literal('taskSummaries'), items: z.array(workspaceTaskSummarySchema).max(100) }),
  z.strictObject({ ...pageBase, collection: z.literal('pendingInteractions'), items: z.array(workspaceInteractionSchema).max(100) }),
  z.strictObject({ ...pageBase, collection: z.literal('recentMessages'), items: z.array(workspaceMessageSchema).max(100) }),
  z.strictObject({ ...pageBase, collection: z.literal('artifactSummaries'), items: z.array(workspaceArtifactSchema).max(100) }),
]).superRefine((value, context) => {
  validateRows(value.collection, value.items, value.scope, value.teamRunId, context);
  if (value.collection === 'runSummaries' ? value.teamRunId !== null : value.teamRunId === null) context.addIssue({ code: 'custom', message: 'Invalid page run scope' });
  if (value.cursor === value.nextCursor) context.addIssue({ code: 'custom', message: 'Page cursor did not advance' });
  if (value.collection === 'recentMessages' && value.items.some(row => row.createdSeq > value.watermark)) context.addIssue({ code: 'custom', message: 'Message creation exceeds snapshot watermark' });
  bound(value, context);
});
export type WorkspacePage = z.infer<typeof workspacePageSchema>;
export type WorkspacePageRequest = {
  collection: WorkspaceCollection; snapshotId: string; watermark: number; teamRunId: string | null; cursor: string; limit?: number;
};
export const workspacePageRequestSchema = z.strictObject({
  collection: z.enum(WORKSPACE_COLLECTIONS), snapshotId: id, watermark: seq, teamRunId: nullableId,
  cursor: z.string().min(1).max(4_096), limit: z.number().int().min(1).max(100).optional(),
}).refine(value => value.collection === 'runSummaries' ? value.teamRunId === null : value.teamRunId !== null, 'Invalid collection run scope');

export const workspaceChangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('group'), group: workspaceGroupSchema }),
  z.strictObject({ kind: z.literal('member'), member: workspaceMemberSchema }),
  z.strictObject({ kind: z.literal('run_member'), runMember: workspaceRunMemberSchema }),
  z.strictObject({ kind: z.literal('run'), run: workspaceRunSummarySchema }),
  z.strictObject({ kind: z.literal('task'), task: workspaceTaskSummarySchema }),
  z.strictObject({ kind: z.literal('interaction'), interaction: workspaceInteractionSchema }),
  z.strictObject({ kind: z.literal('message'), message: workspaceMessageSchema }),
  z.strictObject({ kind: z.literal('artifact'), artifact: workspaceArtifactSchema }),
  z.strictObject({ kind: z.literal('invalidate'), teamRunId: nullableId, collections: z.array(z.enum(WORKSPACE_COLLECTIONS)).min(1).max(5) }),
]);
export type WorkspaceChange = z.infer<typeof workspaceChangeSchema>;
export const workspaceEventSchema = z.strictObject({
  apiVersion: z.literal(TEAMS_API_VERSION), viewVersion: z.literal(TEAMS_WORKSPACE_VERSION), scope: workspaceScopeSchema,
  eventId: id, groupSeq: revision, type: z.literal('workspace.delta'), createdAt: timestamp, changes: z.array(workspaceChangeSchema).max(32),
}).superRefine((value, context) => {
  for (const change of value.changes) {
    if (change.kind === 'invalidate') continue;
    const row = change.kind === 'group' ? change.group : change.kind === 'member' ? change.member : change.kind === 'run_member' ? change.runMember
      : change.kind === 'run' ? change.run : change.kind === 'task' ? change.task : change.kind === 'interaction' ? change.interaction
        : change.kind === 'message' ? change.message : change.artifact;
    if (!scoped(row, value.scope) || (change.kind === 'group' && change.group.authorityRef !== value.scope.authorityId)) context.addIssue({ code: 'custom', message: 'Foreign row in workspace delta' });
    if (change.kind === 'message' && change.message.createdSeq > value.groupSeq) context.addIssue({ code: 'custom', message: 'Future message in workspace event' });
  }
  bound(value, context);
});
export type WorkspaceEvent = z.infer<typeof workspaceEventSchema>;

function parse<T>(schema: { parse(raw: unknown): T }, raw: unknown): T {
  try { return schema.parse(raw); } catch { throw new TeamsError('workspace_contract_mismatch', '团队工作区数据格式不兼容，需要重新读取。'); }
}
export function decodeTeamWorkspaceSnapshot(raw: unknown): TeamWorkspaceSnapshot { return parse(teamWorkspaceSnapshotSchema, raw); }
export function decodeWorkspacePage(raw: unknown): WorkspacePage { return parse(workspacePageSchema, raw); }
export function decodeWorkspaceEvent(raw: unknown): WorkspaceEvent { return parse(workspaceEventSchema, raw); }
