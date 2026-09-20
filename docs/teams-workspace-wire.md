# Teams cloud workspace/v1 wire contract

Status: Web decoder, projection, read-only transport and observer implemented. Server projection / durable snapshot pagination and product UI integration are separate work; these APIs do not imply that a cloud service is already available.

The runtime source of truth is [`workspaceContracts.ts`](../src/core/teams/workspaceContracts.ts). Existing full local `GroupSnapshot`, `GroupReducer` and `HttpTeamsClient` retain their existing behavior. A partial workspace must never be passed to the full local reducer.

## 1. Identity and consistency

Every snapshot, page and event contains:

```ts
type WorkspaceScope = {
  authorityId: string;
  ownerScopeRef: string;
  groupId: string;
};
```

The client additionally owns an immutable `origin`. Its cache key includes origin, owner, authority and group. The server derives identity from verified authentication; request fields cannot override the authenticated owner. It must return the exact requested scope. `group.authorityRef` is the existing domain field and equals `scope.authorityId`.

All counters, revisions and cursors expressed as numbers must be safe JavaScript integers; revisions start at 1 and watermarks start at 0. Strings and JSON must be safely representable by the new Teams JCS contract. Unknown fields in this view version are rejected. Identity strings are nonempty and at most 256 characters, except `ownerScopeRef` (512). Opaque pagination cursors are at most 4096 characters.

## 2. Snapshot

`GET /groups/{groupId}/workspace?viewVersion=workspace/v1&teamRunId={optional}`

The Studio same-origin base is `/api/v1/groups`; a cloud host can configure `/agentengine/api/v1/teams/groups`. The base must belong to the configured origin. If a requested `teamRunId` is present, returning another run is an error. An omitted `teamRunId` allows the server to choose its default run on the first read. The observer pins the resolved run on subsequent reconnects.

```ts
type TeamWorkspaceSnapshot = {
  apiVersion: 'teams.ksadk.io/v1';
  viewVersion: 'workspace/v1';
  scope: WorkspaceScope;
  snapshotId: string;
  watermark: number;
  group: WorkspaceGroup;
  members: WorkspaceMember[];                 // <= 8
  runSummaries: WorkspaceRunSummary[];         // <= 20
  selectedRun: WorkspaceRunSummary | null;
  selectedRunMembers: WorkspaceRunMember[];    // <= 8
  taskSummaries: WorkspaceTaskSummary[];        // <= 100
  pendingInteractions: WorkspaceInteraction[]; // <= 50
  recentMessages: WorkspaceMessage[];          // <= 50
  artifactSummaries: WorkspaceArtifact[];      // <= 50
  cursors: Record<WorkspaceCollection, string | null>;
};
type WorkspaceCollection =
  | 'runSummaries' | 'taskSummaries' | 'pendingInteractions'
  | 'recentMessages' | 'artifactSummaries';
```

The initial response must come from one consistent transaction at watermark W. The server persists a bounded read-only snapshot with a TTL, and returns its opaque `snapshotId`. Do not keep a database connection/transaction open across HTTP requests. Do not label later reads of current mutable objects with an older snapshot watermark.

`selectedRun` can be outside the first run summary page. If it is present in that page, the two records must be identical at W. The selected frozen roster must include its Leader and the same `groupRevision`. Task dependencies may reference tasks outside the loaded page.

All task, interaction, message and artifact collections in this version belong to the selected run. No selected run means these collections and their cursors are empty/null. Group-level notes (`teamRunId:null`) are not mixed into a selected task history. A future group conversation view must define its own explicit query/window instead of silently mixing unrelated task histories.

## 3. Exact record fields

All fields below are required unless explicitly marked `?`. Nullable fields are sent as `null`; these schemas do not invent missing readiness, counts or state. Status strings retain the existing domain names.

```ts
type WorkspaceGroup = {
  groupId: string; name: string; authorityRef: string;
  tenantId: string; ownerSubject: string; leaderMemberId: string;
  revision: number; status: 'active' | 'archived';
  createdAt: string; updatedAt: string;
  policy: { taskAcceptance: 'leader' | 'human' | 'result'; peerWake: boolean };
};

type WorkspaceMember = {
  memberId: string; groupId: string; name: string;
  role: 'leader' | 'member'; responsibility: string;
  bindingRef: string;
  binding: {
    bindingRef: string; providerRef: string;
    kind: 'local_build' | 'a2a' | 'cloud'; agentId: string;
    capabilities: {
      enqueue: boolean; cancel: boolean; steer: boolean;
      restore: boolean; interaction: boolean; leader: boolean;
    };
    availability: {
      state: 'ready' | 'unchecked' | 'unavailable';
      code: string | null; reason: string | null; action: string | null;
    };
  };
  sessionId: string; revision: number;
  status: 'active' | 'removed' | 'unavailable';
  executionStatus: 'idle' | 'queued' | 'running' | 'waiting' | 'needs_attention' | 'unavailable';
  activeRunId: string | null; reason: string | null;
};
type WorkspaceRunMember = WorkspaceMember & {
  runMemberId: string; teamRunId: string; groupRevision: number;
};

type WorkspaceRunSummary = {
  teamRunId: string; groupId: string; revision: number; groupRevision: number;
  goalMessageId: string; goal: string; leaderMemberId: string;
  status: 'planning' | 'running' | 'waiting' | 'needs_attention'
    | 'awaiting_acceptance' | 'succeeded' | 'failed' | 'cancel_requested' | 'cancelled';
  dispatchSuspended: boolean; dispatchEpoch: number;
  taskCount: number; pendingCount: number;
  createdAt: string; updatedAt: string; reason: string | null;
};
type WorkspaceTaskSummary = {
  taskId: string; groupId: string; teamRunId: string; revision: number;
  title: string; ownerMemberId: string | null; dependencies: string[];
  status: 'draft' | 'ready' | 'blocked' | 'running' | 'awaiting_acceptance'
    | 'succeeded' | 'failed' | 'cancel_requested' | 'cancelled';
  attemptCount: number; reason: string | null;
};

type MemberSource = {
  authorityRef: string; groupId: string; memberId: string; bindingRef: string;
  providerRef: string; sessionId: string; runId: string; itemId?: string;
};
type WorkspaceInteraction = {
  ref: MemberSource & { interactionId: string };
  groupId: string; teamRunId: string; revision: number; title: string;
  kind: 'approval' | 'input';
  status: 'pending' | 'resolving' | 'resolved' | 'cancelled' | 'expired';
  createdAt: string;
};
type WorkspaceMessage = {
  messageId: string; groupId: string; teamRunId: string | null;
  revision: number; createdSeq: number; createdAt: string;
  senderPrincipal: string; senderName: string;
  groupRole: 'owner' | 'leader' | 'member' | 'system'; memberId: string | null;
  parts: Array<{ kind: 'text'; text: string } |
    { kind: 'attachment'; attachmentRef: string; mediaType: string; name?: string }>;
  mentions: string[];
  intent: 'start_goal' | 'followup' | 'directed' | 'note' | 'result' | 'progress';
  replyTo: string | null; sourceRefs: MemberSource[];
  visibility: 'public' | 'internal';
};
type WorkspaceArtifact = {
  artifactId: string; groupId: string; teamRunId: string; revision: number;
  name: string; mediaType: string; source: MemberSource;
  digest: string; sizeBytes: number; state: 'pending' | 'ready' | 'failed';
};
```

`pendingCount` is the authoritative pending owner/approval count for that run, not a client count of a truncated page. `taskCount` counts its complete task set. Task description, acceptance criteria, attempt results and other large bodies use the existing task detail endpoint; they are absent from summaries. Raw runtime approval tokens and credentials are never included in these projections.

`revision` retains its business CAS meaning. The two run summary counters may change at a later group event sequence without changing that revision; the reducer tracks the observation sequence separately and prevents a W page from overwriting newer counters. Other domain fields cannot change at the same object revision. The server must project counters at the corresponding event/snapshot boundary, or emit `invalidate` when that projection is unavailable.

Message `createdSeq` is its original group creation sequence (the stored `_createdSeq` projected into the public DTO), unchanged by edits. Messages in each snapshot/page are oldest first, with increasing `createdSeq`. Equal text does not identify a message. Source refs must match the enclosing authority/group. `pendingInteractions` contains only `pending` or `resolving`; terminal states occur in deltas and remove the pending item while retaining its revision tombstone locally.

## 4. Stable pages

| Collection | GET path relative to `/groups/{g}` | Run scope |
|---|---|---|
| runSummaries | `/team-runs` | `teamRunId:null` in page DTO |
| taskSummaries | `/team-runs/{r}/tasks` | selected run |
| pendingInteractions | `/team-runs/{r}/interactions` | selected run |
| recentMessages | `/team-runs/{r}/messages` | selected run |
| artifactSummaries | `/team-runs/{r}/artifacts` | selected run |

Query parameters: `viewVersion=workspace/v1`, `snapshotId`, `watermark=W`, `cursor`, `limit` (1–100). A non-null cursor comes from the initial snapshot or the preceding page, never from a client-computed offset.

```ts
type WorkspacePage = {
  apiVersion: 'teams.ksadk.io/v1'; viewVersion: 'workspace/v1';
  scope: WorkspaceScope; snapshotId: string; watermark: number;
  collection: WorkspaceCollection; teamRunId: string | null;
  cursor: string; // Echo of the exact requested cursor.
  items: Array<RecordForCollection>; // <= 100; homogeneous and strictly decoded.
  nextCursor: string | null;
};
```

The server must bind each cursor to owner, authority, group, snapshot, collection and run. Returning a cursor from another snapshot or collection is an error. At TTL expiry return non-2xx `snapshot_expired` (409), never an empty successful page. Only `nextCursor:null` means that the frozen collection is exhausted. A page may be empty if its cursor advances, but cursors must not cycle.

Live events can advance the view watermark beyond W while a W page is in flight. The reducer keeps `snapshotWatermark=W` separately, merges by stable ID/revision, and retains terminal-interaction tombstones so an old page cannot resurrect resolved work. New snapshots reset the pagination context. Late responses for an old context are ignored by the observer generation/snapshot identity.

## 5. Every group event has a projection frame

`GET /groups/{g}/events?after={watermark}&viewVersion=workspace/v1`

Use SSE `event: workspace.delta` (the client also accepts `workspace.event` and the default `message` frame, with the same strict body). Unknown frame names or malformed JSON trigger snapshot resync. Do not filter the group event sequence by selected run. Every stored domain `groupSeq` after the requested cursor must yield exactly one projection frame. Translate the domain object to a summary; do not ship full task bodies merely to discard them in the browser.

```ts
type WorkspaceEvent = {
  apiVersion: 'teams.ksadk.io/v1'; viewVersion: 'workspace/v1';
  scope: WorkspaceScope; eventId: string; groupSeq: number;
  type: 'workspace.delta'; createdAt: string; changes: WorkspaceChange[]; // <= 32
};
type WorkspaceChange =
  | { kind: 'group'; group: WorkspaceGroup }
  | { kind: 'member'; member: WorkspaceMember }
  | { kind: 'run_member'; runMember: WorkspaceRunMember }
  | { kind: 'run'; run: WorkspaceRunSummary }
  | { kind: 'task'; task: WorkspaceTaskSummary }
  | { kind: 'interaction'; interaction: WorkspaceInteraction }
  | { kind: 'message'; message: WorkspaceMessage }
  | { kind: 'artifact'; artifact: WorkspaceArtifact }
  | { kind: 'invalidate'; teamRunId: string | null; collections: WorkspaceCollection[] };
```

Events with no visible projection changes use `changes:[]` and still advance the watermark. Nonselected-run changes update run summaries or dirty-run markers, never the selected task collections. `invalidate` marks a collection for refresh when a compact complete row cannot be safely supplied; it does not fabricate state. Every delta batch commits atomically in the client, and contradictory contents for the same object revision require resynchronization.

Exact `(eventId,groupSeq)` duplicates are ignored; a gap, reused event identity, unknown view event/change type, or explicit SSE `reset_required` triggers a fresh workspace. On ordinary network reconnect the observer resumes from its last watermark without sending commands. Repeated invalid snapshots/events stop after the bounded retry limit and expose an offline/error state.

Snapshots, pages and individual delta payloads are at most 2 MiB in UTF-8. The server must shorten windows or use explicit invalidation/detail reads rather than truncate original content. A single oversized message needs a content/detail contract before it can be exposed by this view; the client rejects an oversized body instead of claiming it loaded it.

## 6. Integration lifecycle

```ts
const client = new HttpCloudWorkspaceClient({ origin, fetch: authenticatedFetch });
const observer = new WorkspaceObserver({ origin, ownerScopeRef, authorityId, groupId }, client);
// Connect useSyncExternalStore to observer.subscribe / observer.getSnapshot.
void observer.observe(teamRunId);
observer.setDraft('Unsent text');
await observer.loadMore('recentMessages');
observer.refresh();
observer.dispose(); // On logout, identity change or final page disposal.
```

Scope is immutable. Create a new observer when identity/origin/authority/group changes. Run selection starts a new generation; stale snapshots, pages and callbacks cannot alter the new run. Drafts belong to the observer and selected run, survive reconnect/resync, and are cleared on disposal or revoked access. Leaving observation never cancels an Agent.

The transport has only `read`, `page` and `subscribe`. Mutations use `TeamsOperationOutbox` and require their original idempotency key; this observer must not replay a user goal to recover a disconnected stream.

The default projection cache refuses to silently discard unresolved loaded objects after 5,000 rows in one collection; it requests a new bounded snapshot. The limit is configurable from 100 to 50,000. Event duplicate identity tracking keeps a bounded recent window of 10,000 frames; earlier sequences are already covered by the current watermark.

## 7. Verification

`src/__tests__/teams-workspace.test.ts` covers scope/selected-run checks, partial dependency references, live events versus old pages, terminal interaction tombstones, complete group watermarks, gap/unknown-event resync, page expiry, stale run-switch responses, per-owner/origin cache isolation, draft retention and access revocation. It uses an injected transport and synthetic test data only; production responses are never replaced with successful fixtures.

## Product adapter contract (T09 UI integration)

Cloud UI is feature gated. Lifecycle must expose trusted `authorityId`, `ownerScopeRef`, `features`. `workspace-projection.v1` permits reads; `durable-operations.v1` plus ready health permits mutations. Missing features show an explicit unavailable/read-only state. UI never falls back to legacy local GroupSnapshot in server mode. `features=[]` does not claim product readiness.

### Expected identity preconditions

Every cloud JSON/SSE request sends `X-Teams-Authority-Id` and `X-Teams-Owner-Scope-Ref` from the lifecycle that owns the current view/outbox. These are **comparison preconditions, never authentication headers**. The authenticated Server derives its own principal and rejects a different expected identity before lookup, writes or streaming. The Studio proxy must retain these preconditions and compare against its current trusted cloud identity; it must not construct an owner principal from browser input. This prevents a stale tab from delivering an old outbox after credentials switch on the same Studio origin. Failed identity checks leave operations uncertain and require restoring the original identity, not a new key.

Clients use fixed same-origin URLs, `credentials: same-origin`, `cache: no-store`, and `redirect: error`. The proxy's `/api/v1/groups/**` maps to Server `/groups/**`; `/api/v1/teams/operations/lookup` maps to Server `/operations/lookup`. Group artifact download links cannot set custom headers, so they instead require the equivalent `expectAuthorityId`, `expectOwnerScopeRef`, and `teamRunId` query preconditions, with the same authenticated comparison on the Server. No bearer token or temporary URL is put into the query.

### Binding directory

`GET /groups/bindings?limit=100&cursor=...` returns the strict envelope below. Every `authorityRef` must match scope; `bindingRef` values must be unique within a page. A cursor cannot repeat itself. The UI sends only a selected `bindingRef` to create a group; transport targets and credentials are not part of this catalog.

```ts
type CloudBindingDirectory = {
  apiVersion: 'teams.ksadk.io/v1';
  scope: { authorityId: string; ownerScopeRef: string };
  items: Array<{ // <= 100
    bindingRef: string; providerRef: string;
    kind: 'local_build' | 'cloud' | 'a2a';
    agentId: string; name: string; revision: number; authorityRef: string;
    capabilities: { enqueue: boolean; cancel: boolean; steer: boolean;
      restore: boolean; interaction: boolean; leader: boolean };
    availability: { state: 'ready' | 'unchecked' | 'unavailable';
      code: string | null; reason: string | null; action: string | null };
  }>;
  nextCursor: string | null;
};
```

IDs and names are nonempty with maximum 256 characters, ownerScopeRef maximum 512, reason maximum 2000, and cursor maximum 4096. Revision is a positive safe integer. Unknown fields, including accidental credential fields, are rejected. Expected identity headers contain printable ASCII identifiers.

### Team directory

`GET /groups?limit=50&cursor=...` returns `{apiVersion,scope:{authorityId,ownerScopeRef},items,nextCursor:null|string}`. Each item is the strict workspace `group` object plus `memberCount,pendingCount,unreadCount` (nonnegative safe integers), `lastMessage` (string, default empty). All rows must belong to authorityId. Pagination preserves earlier loaded rows; search applies to loaded rows only.

### Durable mutations

Outbox digest remains SHA256(JCS(`{operation,payload}`)); the HTTP payload additionally carries `idempotencyKey`. UI uses these stable operation identifiers:

| operation | HTTP | Business payload |
| --- | --- | --- |
| `groups` | POST /groups | name,members:[{memberId,name,bindingRef,responsibility?}],leaderMemberId,leaderStandbyBindingRef? |
| `groups/{g}/messages` | POST /groups/{g}/messages | parts,mentions,intent:start_goal/followup/directed,teamRunId? (required for followup/directed),materialManifestRef? (start only) |
| `groups/{g}/team-runs/{r}/control` | POST corresponding resource | action:suspend_dispatch/resume_dispatch/stop,expectedRevision |
| `groups/{g}/team-runs/{r}/acceptance` | POST corresponding resource | action:accept/request_changes/reject,expectedRevision,reason? |
| `groups/{g}/tasks/{t}/actions` | POST corresponding resource | action:retry/accept/reject,expectedRevision,reason? |
| `groups/{g}/interactions` | POST corresponding resource | ref:full InteractionRef,expectedRevision,action:approve/reject/submit/cancel,response:object |

`POST /operations/lookup` receives `{idempotencyKey,operation,targetId}` (targetId=groupId, empty only creating group). Definitive missing is exactly `{status:"missing"}`. Mutation and found lookup use the same envelope:

```json
{"status":"confirmed","operationId":"op_01","payloadDigest":"sha256:...","receipt":{"status":"accepted","groupId":"group_01","teamRunId":"run_01","messageId":"message_01","watermark":42}}
```

`status` is confirmed/rejected/pending/uncertain; `receipt` is object or null. Optional `code` is a stable rejection code. Receipt supports `status` accepted/duplicate/rejected/uncertain, optional groupId/teamRunId/messageId/watermark/reason. **confirmed means transaction accepted, never execution completed.** Digest must match the original persisted intent. HTTP errors, malformed replies, digest mismatch remain uncertain; none authorizes resend without lookup returning missing. Identical unresolved intent is reused atomically within the IndexedDB transaction, including two tabs racing to enqueue; the CAS lease permits one sender. Identity changes unmount and deactivate all drains. Read-only/offline views retain pending intents and do not initiate sending. No credentials or transport envelope is persisted.

### On-demand details

`GET /groups/{g}/interactions/{interactionId}?teamRunId={r}&authorityRef=...&groupId=...&memberId=...&bindingRef=...&providerRef=...&sessionId=...&runId=...&interactionId=...&itemId=...` uses the full source ref for authorization (`itemId` only if present). Response is the strict workspace interaction summary plus `message:string,requestSchema:object|null`. Ref, teamRunId, groupId and revision must match the selected summary. UI does not approve from an unloaded summary. Pending `input` without a usable schema cannot be converted into blanket approval. Secret/password schema fields must not be submitted through durable browser storage.

`GET /groups/{g}/tasks/{t}?teamRunId={r}` returns existing TeamTask detail (full description, attempts, candidate result, acceptance criteria); groupId/teamRunId/taskId/revision validated before rendering or action.

`GET /groups/{g}/artifacts/{artifactId}/content?teamRunId={r}&expectAuthorityId={a}&expectOwnerScopeRef={o}` authorizes every download from the selected run; the browser constructs this fixed same-origin URL rather than trusting a URI from output text. No presigned credential is cached.

A confirmed receipt must contain groupId. `start_goal` additionally requires teamRunId. A receipt's teamRunId, when present for an existing run operation, must match the target run. This prevents clearing a draft when the created resource cannot be identified.

### Implementation and verification boundary

Product entry: SDK Studio `TeamsPage.tsx` routes server mode to `StudioCloudTeamsPage.tsx`; local mode retains its original `useTeamChat`/`TeamWorkspace` flow. W exports `CloudTeamWorkspace`, `HttpCloudTeamsProductClient`, and `CloudOperations`. Studio must build against this matching W source/bundle; the previously published package does not contain these new exports. No package version or release is included in this change.

Controlled browser fixture is `e2e/fixtures/cloud-teams.html`, clearly labeled test data, never imported by product. Run `npx playwright test --config playwright.cloud-teams.config.mjs`. It validates paging/run isolation, approval detail loading and read-only degradation, lost receipt recovery across refresh with real browser IndexedDB, and narrow layout. This verifies client behavior, not live Server functionality.

Real integration remaining: same-origin SDK proxy routing; Server feature advertisement only after actual readiness; scoped directory/binding pages; durable mutation/lookup envelope and payload digest; snapshot TTL paging and full-sequence SSE; task/interaction details; authorized artifact content; live node reconnect/admission behavior. Server currently advertises no workspace feature, so the product shows initialization rather than synthetic execution data.


## Effect reconciliation owner view

Lifecycle feature `effects.reconcile` enables the additional cloud-only review tab; absent features do not expose it. Local Teams remains unchanged. Read errors never become empty success. The effect ledger and authenticated Host recovery are separate from this owner UI.

- `GET /groups/{groupId}/team-runs/{teamRunId}/effects?after=0&limit=50` returns `{scope:{authorityId,ownerScopeRef,groupId},teamRunId,items,nextCursor}`. `nextCursor` is a positive safe integer or null. Each item includes only `effectKey,groupId,teamRunId,toolName,effectClass,phase,revision,evidenceDigest,resolution,resolutionConflict,outcome`. The strict decoder is `src/core/teams/cloudEffects.ts`; no frozen workload request or credential carrier is returned. Pages may have zero filtered items with a non-null advancing cursor; clients must offer the next page.
- `POST /groups/{groupId}/effects/{effectKey}/reconcile` has business payload `{expectedRevision,expectedEvidenceDigest,decision,evidenceRef,reason}`, plus the original transport `idempotencyKey`. The canonical operation is that path without the leading slash; targetId is groupId. Server `reconcile_operation` commits the effect decision, audit and standard operation outcome together. Generic operations lookup recovers a lost acknowledgement.
- Confirmed operation `receipt` adds `{status:"accepted",groupId,teamRunId,effectKey,phase:"resolved",revision,resolutionId,decision,evidenceDigest}`. The client requires the original effect target, business digest and decision to match. A CAS failure is a persistent rejected operation, not a missing receipt or a successful completion.
- The initial owner UI exposes only `accept_risk`, requiring an explicit acknowledgement and a nonempty review reason. `evidenceRef` is a local-generated opaque manual review ID; it does not claim external system proof. `confirmed_applied` and `confirmed_not_applied` require a separate trusted external evidence reader and are not offered by this UI.
- Every submit is persisted in the existing scoped IndexedDB outbox. Uncertain decisions are looked up with the same key; a second decision for that unresolved effect is disabled. SSE revision changes preserve the unsent explanation, invalidate its old expectedRevision/evidenceDigest and require fresh review. Selected-run changes abort old requests and never mix evidence.
- Public resolution currently preserves the owner audit fields `resolutionId,expectedRevision,expectedEvidenceDigest,decision,evidenceRef,reason,kind,actorSubject,ownerScopeRef,verifiedOutcome`; these exact fields are validated. Manual acceptance records risk, does not mark a native run completed and does not automatically replay an external call. Contradictory late evidence stays blocked via resolutionConflict.

### Leader 备用与接管只读投影

`runSummaries[]` 和 `selectedRun` 可选 `leaderStandby`；未配置备用时省略，不返回 `null`。对象为严格字段集合：

```ts
{
  state: 'armed' | 'fencing_old' | 'waiting_old_grant' | 'activating' | 'active' | 'blocked';
  standbyBindingRef: string;
  releaseRef: string;
  takeoverId: string | null;
  reason: string | null; // <= 2000 characters, public reason only
  newLeaderEpoch: number | null; // positive safe integer
}
```

`armed` 表示已配置，不能据此宣称原 Leader 已切换。投影可把已接管但收到待核查外部证据的执行显示为 `blocked`，不修改权威接管历史。Web 只展示状态及原因，没有手动替换按钮，不凭这些字段创建执行能力。

接管状态属于 groupSeq 时点的派生投影，不改变 run 的业务 CAS revision。`leader_takeover.updated` 的 `payload.takeover.teamRunId` 映射为 `workspace.delta` 的 `invalidate`，collection 为 `runSummaries`；客户端重读一致快照。迟到分页不能覆盖较新 groupSeq 的备用状态；切换 selectedRun 即清空旧工作区，离线视图沿用已有最后同步标记。

本地 `live_workspace_server.py` 的 standby 测试控制只写临时 PG 投影记录，经真实产品 snapshot/SSE 验证显示；不执行 Host 接管，也不作为发布一致性、授权撤销或真实云执行的验收证据。
