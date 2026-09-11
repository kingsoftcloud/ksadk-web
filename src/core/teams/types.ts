import type { ConversationItem } from '../conversation/types.js';

export const TEAMS_API_VERSION = 'teams.ksadk.io/v1' as const;
export type TeamStatus = 'planning' | 'running' | 'waiting' | 'needs_attention' | 'awaiting_acceptance' | 'succeeded' | 'failed' | 'cancel_requested' | 'cancelled';
export type TaskStatus = 'draft' | 'ready' | 'blocked' | 'running' | 'awaiting_acceptance' | 'succeeded' | 'failed' | 'cancel_requested' | 'cancelled';
export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'closed';
export type MessageIntent = 'start_goal' | 'followup' | 'directed' | 'note';
export type TeamControlAction = 'suspend_dispatch' | 'resume_dispatch' | 'stop';
export type TaskAction = 'assign' | 'claim' | 'retry' | 'accept' | 'reject';

export type TeamCapabilities = {
  enqueue: boolean;
  cancel: boolean;
  steer: boolean;
  restore: boolean;
  interaction: boolean;
  leader: boolean;
};
export type ExecutionBinding = {
  bindingRef: string;
  providerRef: string;
  kind: 'local_build' | 'a2a';
  agentId: string;
  buildId?: string;
  version?: string;
  location?: string;
  revision?: number;
  authorityRef?: string;
  tenantId?: string;
  pluginLockDigest?: string;
  target?: { kind: 'local_build' | 'a2a_space_agent'; [key: string]: unknown };
  capabilities: TeamCapabilities;
};
export type Group = {
  groupId: string;
  name: string;
  authorityRef: string;
  tenantId: string;
  ownerSubject: string;
  policy?: { taskAcceptance: 'human' | 'result'; peerWake: boolean };
  leaderMemberId: string;
  revision: number;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
};
export type GroupSummary = Group & {
  memberCount: number;
  pendingCount: number;
  unreadCount: number;
  activeTeamRunId?: string | null;
  activeStatus?: TeamStatus | null;
  lastMessage?: string;
};
export type AgentMember = {
  memberId: string;
  groupId: string;
  name: string;
  role: 'leader' | 'member';
  bindingRef: string;
  binding: ExecutionBinding;
  sessionId: string;
  revision: number;
  status: 'active' | 'removed' | 'unavailable';
  executionStatus: 'idle' | 'queued' | 'running' | 'waiting' | 'needs_attention' | 'unavailable';
  activeRunId?: string | null;
  reason?: string;
};
export type MemberStreamRef = {
  authorityRef: string;
  groupId: string;
  memberId: string;
  bindingRef: string;
  providerRef: string;
  sessionId: string;
  runId: string;
  itemId?: string;
};
export type InteractionRef = MemberStreamRef & { interactionId: string };
export type TeamArtifact = {
  artifactId: string;
  name: string;
  mediaType: string;
  source: MemberStreamRef;
  digest?: string;
  uri?: string | null;
};
export type GroupMessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'attachment'; attachmentRef: string; mediaType: string; name?: string };
export type GroupMessage = {
  messageId: string;
  groupId: string;
  revision: number;
  createdAt: string;
  senderPrincipal: string;
  senderName: string;
  groupRole: 'owner' | 'leader' | 'member' | 'system';
  memberId?: string | null;
  teamRunId?: string | null;
  parts: GroupMessagePart[];
  mentions: string[];
  intent: MessageIntent | 'result' | 'progress';
  replyTo?: string | null;
  sourceRefs?: MemberStreamRef[];
  visibility: 'public' | 'internal';
};
export type TeamBudget = {
  maxMembers: number;
  maxConcurrent: number;
  maxStarts: number;
  startsUsed: number;
  maxHops: number;
  maxTokens?: number;
  tokensUsed?: number;
  maxDurationSeconds?: number;
};
export type TeamRun = {
  teamRunId: string;
  groupId: string;
  groupRevision: number;
  revision: number;
  goalMessageId: string;
  goal: string;
  leaderMemberId: string;
  status: TeamStatus;
  dispatchSuspended: boolean;
  dispatchEpoch: number;
  budget: TeamBudget;
  createdAt: string;
  updatedAt: string;
  reason?: string;
};
export type TaskAttempt = {
  attemptId: string;
  attemptNumber: number;
  executionEpoch: number;
  status: TaskStatus;
  source?: MemberStreamRef;
  result?: string;
  artifacts: TeamArtifact[];
  startedAt?: string | null;
  endedAt?: string | null;
  reason?: string;
};
export type TeamTask = {
  taskId: string;
  groupId: string;
  teamRunId: string;
  revision: number;
  title: string;
  description: string;
  ownerMemberId: string | null;
  dependencies: string[];
  status: TaskStatus;
  acceptanceCriteria: string;
  attempts: TaskAttempt[];
  reason?: string;
};
export type GroupDelivery = {
  deliveryId: string;
  groupId: string;
  teamRunId: string;
  messageId: string;
  memberId: string;
  revision: number;
  status: 'pending' | 'accepted' | 'rejected' | 'uncertain' | 'cancelled';
  commandId?: string | null;
  runId?: string | null;
  reason?: string;
};
export type TeamInteraction = {
  ref: InteractionRef;
  revision: number;
  title: string;
  message: string;
  kind: 'approval' | 'input';
  status: 'pending' | 'resolving' | 'resolved' | 'cancelled' | 'expired';
  requestSchema?: Record<string, unknown> | null;
  createdAt: string;
  outcome?: string | null;
};
export type GroupSnapshot = {
  apiVersion: typeof TEAMS_API_VERSION;
  group: Group;
  watermark: number;
  members: AgentMember[];
  messages: GroupMessage[];
  teamRuns: TeamRun[];
  tasks: TeamTask[];
  deliveries: GroupDelivery[];
  interactions: TeamInteraction[];
  artifacts?: TeamArtifact[];
};
export type GroupEvent = {
  apiVersion: typeof TEAMS_API_VERSION;
  eventId: string;
  groupId: string;
  groupSeq: number;
  type: string;
  createdAt: string;
  teamRunId?: string;
  memberId?: string;
  taskId?: string;
  attemptId?: string;
  causationId?: string;
  source?: { sessionId: string; runId: string; eventId: string; seq: number };
  payload: Record<string, unknown>;
};
export type GroupList = { items: GroupSummary[]; nextCursor?: string | null };
export type GroupCreateInput = {
  name: string;
  members: Array<{ memberId: string; name: string; bindingRef: string }>;
  leaderMemberId: string;
  idempotencyKey: string;
};
export type GroupMessageInput = {
  parts: GroupMessagePart[];
  mentions: string[];
  intent: MessageIntent;
  idempotencyKey: string;
  replyTo?: string;
};
export type GroupReceipt = {
  status: 'accepted' | 'duplicate' | 'rejected' | 'uncertain';
  groupId: string;
  messageId?: string;
  teamRunId?: string;
  groupSeq?: number;
  reason?: string;
};
export type TeamInteractionInput = {
  ref: InteractionRef;
  expectedRevision: number;
  action: 'approve' | 'reject' | 'submit' | 'cancel';
  response: Record<string, unknown>;
  idempotencyKey: string;
};
export type ExecutionNode = {
  nodeId: string;
  kind: 'task' | 'run' | 'child_invocation';
  title: string;
  status: string;
  taskId?: string;
  memberId?: string | null;
  attemptId?: string;
  source?: MemberStreamRef | null;
  parentNodeId?: string;
  reason?: string | null;
};
export type ExecutionEdge = { source: string; target: string; kind: 'dependency' | 'invocation' };
export type ExecutionSnapshot = { groupId: string; teamRunId: string; watermark: number; nodes: ExecutionNode[]; edges: ExecutionEdge[] };
export type MemberObservation = { ref: MemberStreamRef; items: ConversationItem[]; cursor: number; connection: ConnectionStatus };
