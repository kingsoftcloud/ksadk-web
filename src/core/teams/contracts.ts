import { z } from 'zod';
import { TEAMS_API_VERSION, type GroupEvent, type GroupSnapshot, type ExecutionSnapshot } from './types.js';

const id = z.string().min(1).max(2048);
const revision = z.number().int().nonnegative();
const timestamp = z.string().min(1);
const status = z.enum(['planning', 'running', 'waiting', 'needs_attention', 'awaiting_acceptance', 'succeeded', 'failed', 'cancel_requested', 'cancelled']);
const taskStatus = z.enum(['draft', 'ready', 'blocked', 'running', 'awaiting_acceptance', 'succeeded', 'failed', 'cancel_requested', 'cancelled']);
export const memberStreamRefSchema = z.object({ authorityRef: id, groupId: id, memberId: id, bindingRef: id, providerRef: id, sessionId: id, runId: id, itemId: id.optional() }).passthrough();
export const interactionRefSchema = memberStreamRefSchema.extend({ interactionId: id });
const capabilities = z.object({ enqueue: z.boolean(), cancel: z.boolean(), steer: z.boolean(), restore: z.boolean(), interaction: z.boolean(), leader: z.boolean() }).passthrough();
export const groupSchema = z.object({ groupId: id, name: z.string().min(1), authorityRef: id, tenantId: id, ownerSubject: id, policy: z.object({ taskAcceptance: z.enum(['human', 'result']), peerWake: z.boolean() }).optional(), leaderMemberId: id, revision, status: z.enum(['active', 'archived']), createdAt: timestamp, updatedAt: timestamp }).passthrough();
export const memberSchema = z.object({ memberId: id, groupId: id, name: z.string().min(1), role: z.enum(['leader', 'member']), bindingRef: id, binding: z.object({ bindingRef: id, providerRef: id, kind: z.enum(['local_build', 'a2a']), agentId: id, capabilities }).passthrough(), sessionId: id, revision, status: z.enum(['active', 'removed', 'unavailable']), executionStatus: z.enum(['idle', 'queued', 'running', 'waiting', 'needs_attention', 'unavailable']) }).passthrough();
const part = z.discriminatedUnion('kind', [z.object({ kind: z.literal('text'), text: z.string() }), z.object({ kind: z.literal('attachment'), attachmentRef: id, mediaType: id, name: z.string().optional() })]);
export const messageSchema = z.object({ messageId: id, groupId: id, revision, createdAt: timestamp, senderPrincipal: id, senderName: z.string(), groupRole: z.enum(['owner', 'leader', 'member', 'system']), parts: z.array(part), mentions: z.array(id), intent: z.enum(['start_goal', 'followup', 'directed', 'note', 'result', 'progress']), sourceRefs: z.array(memberStreamRefSchema).optional(), visibility: z.enum(['public', 'internal']) }).passthrough();
export const artifactSchema = z.object({ artifactId: id, name: z.string(), mediaType: id, source: memberStreamRefSchema }).passthrough();
const attempt = z.object({ attemptId: id, attemptNumber: revision, executionEpoch: revision, status: taskStatus, source: memberStreamRefSchema.optional(), artifacts: z.array(artifactSchema) }).passthrough();
export const taskSchema = z.object({ taskId: id, groupId: id, teamRunId: id, revision, title: z.string().min(1), description: z.string(), ownerMemberId: id.nullable(), dependencies: z.array(id), status: taskStatus, acceptanceCriteria: z.string(), attempts: z.array(attempt) }).passthrough();
export const teamRunSchema = z.object({ teamRunId: id, groupId: id, groupRevision: revision, revision, goalMessageId: id, goal: z.string(), leaderMemberId: id, status, dispatchSuspended: z.boolean(), dispatchEpoch: revision, budget: z.object({ maxMembers: revision, maxConcurrent: revision, maxStarts: revision, startsUsed: revision, maxHops: revision }).passthrough(), createdAt: timestamp, updatedAt: timestamp }).passthrough();
export const deliverySchema = z.object({ deliveryId: id, groupId: id, teamRunId: id, messageId: id, memberId: id, revision, status: z.enum(['pending', 'accepted', 'rejected', 'uncertain', 'cancelled']) }).passthrough();
export const interactionSchema = z.object({ ref: interactionRefSchema, revision, title: z.string(), message: z.string(), kind: z.enum(['approval', 'input']), status: z.enum(['pending', 'resolving', 'resolved', 'cancelled', 'expired']), createdAt: timestamp }).passthrough();
export const groupSnapshotSchema = z.object({ apiVersion: z.literal(TEAMS_API_VERSION), group: groupSchema, watermark: revision, members: z.array(memberSchema), messages: z.array(messageSchema), tasks: z.array(taskSchema), teamRuns: z.array(teamRunSchema), deliveries: z.array(deliverySchema), interactions: z.array(interactionSchema), artifacts: z.array(artifactSchema).optional() }).passthrough();
export const groupEventSchema = z.object({ apiVersion: z.literal(TEAMS_API_VERSION), eventId: id, groupId: id, groupSeq: z.number().int().positive(), type: id, createdAt: timestamp, payload: z.record(z.string(), z.unknown()) }).passthrough();

export const executionNodeSchema = z.object({ nodeId: id, kind: z.enum(['task', 'run', 'child_invocation']), title: z.string(), status: id, taskId: id.optional(), memberId: id.nullable().optional(), attemptId: id.optional(), source: memberStreamRefSchema.nullable().optional(), parentNodeId: id.optional(), reason: z.string().nullable().optional() }).passthrough();
export const executionSnapshotSchema = z.object({ groupId: id, teamRunId: id, watermark: revision, nodes: z.array(executionNodeSchema), edges: z.array(z.object({ source: id, target: id, kind: z.enum(['dependency', 'invocation']) }).passthrough()) }).passthrough();
export function decodeExecutionSnapshot(raw: unknown): ExecutionSnapshot {
  const parsed = executionSnapshotSchema.safeParse(raw);
  if (!parsed.success) throw new TeamsError('contract_mismatch', '执行视图格式不兼容，请刷新或更新客户端。');
  const result = parsed.data;
  const ids = new Set(result.nodes.map(node => node.nodeId));
  if (ids.size !== result.nodes.length || result.edges.some(edge => !ids.has(edge.source) || !ids.has(edge.target)) || result.nodes.some(node => node.source && node.source.groupId !== result.groupId)) throw new TeamsError('scope_mismatch', '执行视图包含无效的节点引用。');
  return result;
}

export class TeamsError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'TeamsError';
    this.code = code;
    this.status = status;
  }
}

export function decodeGroupSnapshot(raw: unknown): GroupSnapshot {
  const parsed = groupSnapshotSchema.safeParse(raw);
  if (!parsed.success) throw new TeamsError('contract_mismatch', '群快照格式不兼容，请刷新或更新客户端。');
  const snapshot = parsed.data as GroupSnapshot;
  const groupId = snapshot.group.groupId;
  const collections = [snapshot.members, snapshot.messages, snapshot.tasks, snapshot.teamRuns, snapshot.deliveries];
  if (collections.some(rows => rows.some(row => row.groupId !== groupId)) || snapshot.interactions.some(row => row.ref.groupId !== groupId || row.ref.authorityRef !== snapshot.group.authorityRef)) {
    throw new TeamsError('scope_mismatch', '群快照包含其他作用域的数据。');
  }
  const sources = [...(snapshot.artifacts || []).map(artifact => artifact.source), ...snapshot.messages.flatMap(message => message.sourceRefs || []), ...snapshot.tasks.flatMap(task => task.attempts.flatMap(attempt => [...(attempt.source ? [attempt.source] : []), ...attempt.artifacts.map(artifact => artifact.source)]))];
  if (sources.some(ref => ref.groupId !== groupId || ref.authorityRef !== snapshot.group.authorityRef)) throw new TeamsError('scope_mismatch', '群快照的产物或执行来源跨越作用域。');
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (!unique((snapshot.artifacts || []).map(row => row.artifactId)) || !unique(snapshot.members.map(row => row.memberId)) || !unique(snapshot.messages.map(row => row.messageId)) || !unique(snapshot.tasks.map(row => row.taskId)) || !unique(snapshot.teamRuns.map(row => row.teamRunId)) || !unique(snapshot.deliveries.map(row => row.deliveryId)) || !unique(snapshot.interactions.map(row => JSON.stringify(row.ref)))) {
    throw new TeamsError('contract_mismatch', '群快照存在重复身份。');
  }
  return snapshot;
}

export function decodeGroupEvent(raw: unknown): GroupEvent {
  const parsed = groupEventSchema.safeParse(raw);
  if (!parsed.success) throw new TeamsError('contract_mismatch', '群事件格式不兼容。');
  return parsed.data as GroupEvent;
}

export function validateGroupCreate(input: { name: string; members: Array<{ memberId: string }>; leaderMemberId: string }) {
  if (!input.name.trim()) throw new TeamsError('invalid_name', '请填写群组名称。');
  if (!input.members.length || input.members.length > 8) throw new TeamsError('invalid_members', '请选择 1–8 位成员。');
  if (new Set(input.members.map(row => row.memberId)).size !== input.members.length) throw new TeamsError('duplicate_member', '成员不能重复。');
  if (!input.members.some(row => row.memberId === input.leaderMemberId)) throw new TeamsError('invalid_leader', 'Leader 必须是已选成员。');
}
