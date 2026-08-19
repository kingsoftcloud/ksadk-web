# Changelog

## 0.3.2-beta.2 - 2026-08-20

Rebuilt the immutable beta artifact from the complete Interaction/v1 source.
This supersedes `0.3.2-beta.1`, whose vendored Hosted UI tarball predated the
two fixes below.

- Treat a successful `SubmitInteraction` receipt as durable acceptance, not as
  proof that the framework execution has already completed its resolution.
- Add the queue tray and read-only historical interaction anchors to the
  published artifact, rather than leaving them only on the Web source branch.

## 0.3.2-beta.1 - 2026-08-19

> Unifies durable human-in-the-loop decisions behind one `Interaction/v1`
> client. Counterpart of the agent-kernel Interaction/v1 contract: pending
> approvals, structured inputs, and AG-UI interrupts normalize to a single
> Interaction shape with one submit path (`SubmitInteraction`) with
> revision CAS, idempotency keys, and first-wins terminal semantics.

### Interaction/v1 (headless core)

- New `src/core/interaction/` module: `InteractionClientImpl` + shared
  `InteractionStore` with strict first-wins semantics (a terminal record
  never regresses to pending), revision-based optimistic concurrency, and
  an idempotency-key double-submit guard.
- Transport adapters normalize three sources into the same Interaction:
  Interaction/v1 SessionEvents (`interaction.requested` / `.resolved`,
  rejection is `resolved.outcome="rejected"`, not a fifth event type),
  Responses `mcp_approval_request`, and AG-UI interrupts. Components never
  branch on the approval protocol.
- New public API: `POST /agentengine/api/v1/SubmitInteraction`
  (`submitInteraction` on `ApiFacade`), receipt decoded with the canonical
  agent-kernel/v1 strict decoder. Pure `/v1/responses` clients keep the
  official `mcp_approval_response` path.
- Refresh/replay: session load replays recent durable SessionEvents into
  the store so a pending Interaction is restored without creating a second
  request; a double click, a stale tab, or a replayed history can never
  duplicate a decision.

### UI

- `InteractionTray` renders above the composer with the current pending
  item, pending count, and queue navigation; the composer input is
  visually subordinated while a decision is pending.
- `InteractionHistoryAnchor` replaces interactive historical approval
  buttons with a read-only status retaining actor, decision time,
  outcome, and a redacted response summary.
- A2UI production wire locked to `0.9.1` with catalog digest validation
  (`validateA2uiPresentation`). Unknown wire versions or catalog
  mismatches fall back to the canonical JSON schema form, then to plain
  approve/reject controls. A validation failure is never mapped to an
  approval.
- Expiry: interactions with a past `expires_at` disable submission
  client-side and surface an expired notice.

### Compatibility

- Old servers without the `interaction_v1` capability keep the 0.3.1
  Responses (`mcp_approval_response`) and AG-UI (`resumeAguiInterrupt`)
  callbacks; the fallback is isolated in the adapters and the shared UI is
  unchanged.
- Public runtime bundle exports `InteractionClientImpl`, `Interaction`,
  adapters, and `interactionIdempotencyKey`.

## 0.3.1 - 2026-08-12 - 2026-08-12

> Identity-aware runtime item reducer. Counterpart of the KsADK `0.8.1`
> canonical RuntimeEvent(schema_version=2) release. Hosted UI and Studio must
> ship this version (or later) to keep stream/replay output consistent with the
> Python canonical pipeline.

### Stream / session reducer

- Introduce `RuntimeItemReducer` (`src/core/stream/runtime-items.ts`) as the
  single canonical store for streaming output. It reduces identity-addressed
  item operations into a per-run projection keyed by
  `runId / scopeId / itemId / partId`, replacing the legacy v1 heuristic dedup
  (`lastText` / per-agent accumulator / `startswith` / suffix overlap /
  text hash).
- Ingress adapters normalize three sources into the same item operations:
  Responses SSE output item ids, session events `Metadata.RuntimeItem`, and
  legacy server events (no identity) via synthesized
  `${invocationId}:legacy-assistant`. `assistant_stream_snapshot` maps to
  replace, `assistant_message` maps to complete. Nothing inspects body text
  to decide identity.

### Compatibility

- Consumers tracking the KsADK `0.8.1` canonical RuntimeEvent must use this
  identity-aware version. `0.3.0` used the v1 heuristic reducer and will
  duplicate or drop output when paired with canonical v2 producers.

## 0.3.0 - 2026-07-24

> **Review candidate, not a published npm release.** `0.3.0` is the web
> counterpart of the KsADK `0.8.0` review branch. No npm tag or package is
> created by this changelog entry.

### Hosted runtime transport

- Add the official `@ag-ui/client` transport and capability-driven runtime
  dispatcher for Hosted Chat. The existing OpenAI Responses stream remains the
  default compatibility path whenever AG-UI is unavailable or not negotiated.
- Make the transport choice a run concern instead of a second page or client:
  session restoration, composer state, streaming state, and the API facade
  stay shared across Responses and AG-UI.

### A2UI and approvals

- Render RuntimeEvent-projected A2UI activities through
  `@copilotkit/a2ui-renderer`, with a bounded activity surface that works in
  the message timeline and on compact viewports.
- Persist and replay activity/approval state with session history. A pending
  card can appear after a reload without a manual refresh; an answered card is
  terminal and does not submit the same approval again.
- Route approval answers through the existing resume contract and expose
  explicit pending, responding, resolved, and error UI states. UI actions do
  not replace backend approval or tool policy enforcement.

### Session and UI fixes

- Repair restored-session history projection, event cursor merging, and active
  approval hydration so a switch/reload does not erase messages or leave a
  stale interactive card above the current run.
- Refine expandable activity layout and mobile spacing so A2UI content remains
  within the chat flow instead of overlaying neighboring messages.

### Tooling and compatibility

- Migrate the app styling pipeline to Tailwind CSS v4.
- Update the locked DOMPurify transitive dependency security patch.
- This candidate requires the corresponding Hosted runtime capability. It does
  not make a new npm package available to `ksadk-python`; Python remains pinned
  to the currently published web package until a reviewed npm publication
  occurs.

## 0.2.18 - 2026-07-08

- Load restored sessions through the server-projected `ListSessionMessages`
  response so long conversations open on the latest message window instead of
  rebuilding history from raw events on the client.
- Restore active run reconnects by unwrapping `GetSession.Session` before
  reading `ActiveRunStatus` and `ActiveInvocationId`.
- Keep older-history pagination working by preserving the latest event cache
  offset after the projected message load.
- Preserve response feedback metadata (`responseId`, `eventId`, trace ids) when
  mapping projected backend messages into the chat transcript.
- Keep session token usage out of the sidebar while showing low-noise estimated
  context tokens inside the active run capsule.

## 0.2.17 - 2026-07-06

- Treat `interrupted` and `resume_failed` as terminal run states when restoring
  or streaming sessions, so background resume failures do not leave the UI in a
  permanently running state.
- Show explicit stopped/failed text for interrupted and resume-failed restore
  paths instead of falling through to generic running state handling.

## 0.2.16 - 2026-07-03

- Keep the conversation transcript scrolled to the latest message after a page
  refresh or session switch instead of jumping to the top, by resetting the
  stickiness state on session change and pinning to the bottom past the
  virtualization measurement window.
- Send a runtime cancel request when stopping a run that has an active
  invocation id, so cooperative cancellation reaches the backend instead of
  only aborting the local stream.
- Treat `running`, `resuming`, `starting`, `queued`, and `pending` run statuses
  as active subscriptions so resumed or just-started runs stay connected.
- Normalize numeric session timestamps that arrive in seconds into
  milliseconds, and fall back to `LastPrompt`/`Summary` for session titles when
  the first prompt is unavailable.
- Tighten TypeScript declarations across the run dispatcher, session event
  record, and message virtualization helper so the package type-checks cleanly
  for consumers.
- Add regression coverage for initial scroll pinning, active run status
  detection, and session state helpers.

## 0.2.15 - 2026-06-29

- Restore complete session event history when switching sessions instead of
  rebuilding the transcript from only the newest event page, preventing older
  turns and tool calls from disappearing until a manual refresh or top-scroll.
- Add guarded paginated event-history loading so stale session switches cannot
  apply partial history to the active transcript.
- Add regression coverage for long sessions whose newest event page starts in
  the middle of a later turn.

## 0.2.14 - 2026-06-29

- Restore persisted `stage_tool_call` and `stage_tool_result` events as visible
  tool calls/results when rebuilding session history, matching KSADK runtime
  background stage activity events.
- Add regression coverage for DeepResearch-style persisted stage tool activity
  so tool progress remains visible after refresh or session switching.

## 0.2.13 - 2026-06-24

- Prevent just-finished streamed messages from disappearing after a follow-up
  turn by avoiding stale session-event replay on run settlement and clearing
  the affected session event cache before sidebar refresh.
- Guard restored run subscriptions and asynchronous session loads so delayed
  events from a previous session cannot overwrite the currently visible
  transcript after switching or creating sessions.
- Repair GFM table rendering when streamed Markdown inserts a blank line between
  a table header and its alignment separator.
- Add regression coverage for stale transcript overwrite prevention and delayed
  Markdown table separators.

## 0.2.12 - 2026-06-24

- Forward the selected model metadata in hosted `RunAgent` requests so the
  runtime can preserve per-model capabilities such as image input and reasoning
  support after model hot switching.
- Keep the selected model lookup stable before run engine creation, avoiding a
  stale metadata payload when the user changes models and immediately submits a
  new message.
- Add regression coverage for `Model` and `ModelMetadata` propagation through
  the Responses-format run request path.

## 0.2.11 - 2026-06-22

- Reuse native terminal sessions by conversation/session id so reopening the
  hosted TUI reconnects to the existing session instead of silently creating a
  duplicate terminal.
- Add explicit `force_new` support for manual terminal creation while preserving
  automatic reuse for existing TUI sessions.
- Exclude generated distribution directories from lint so release checks remain
  stable after `build:all` regenerates `dist-ksadk`, `dist-hosted`, and
  `dist-lib`.

## 0.2.10 - 2026-06-18

- Add session list pagination support for `ListSessions`, including `Total`,
  `Page`, and `PageSize` metadata passthrough in the shared API facade.
- Add session event windowing support for `ListSessionEvents`, including
  `Offset`, `Limit`, and `Total`, then load older events on demand when the
  message view scrolls near the top.
- Cache restored session events in the shared session store so resumed sessions
  can prepend older history without losing checkpoint or feedback state.
- Add incremental sidebar loading for long session lists and allow manual pinning
  of important sessions so pinned items stay above recency sorting.
- Virtualize long message transcripts in `ChatMessageList` to avoid rendering
  the full message array at once during long-running or attachment-heavy chats.
- Add regression coverage for facade pagination payloads, sidebar prefetch,
  pinned sessions, top-of-history loading, and message virtualization contracts.

## 0.2.9 - 2026-06-16

- Treat `save_memory` results with `status: accepted_not_extracted` as an
  accepted intermediate state instead of rendering them as failed tool calls.
- Preserve the same non-failed rendering when restoring tool results from
  persisted session history.

## 0.2.8 - 2026-06-15

- Stop the active session activity banner when the user stops generation, so
  completed foreground UI no longer leaves a session marked as still running.
- Use the session-scoped run id when cancelling a background long task, then
  settle that session activity instead of leaving it in a waiting state.
- Add regression coverage for session-scoped streaming activity cleanup.

## 0.2.7 - 2026-06-15

- Prepare the public `@kingsoftcloud/ksadk-web` package for shared consumption
  by KSADK embedded UI and AgentEngine hosted UI.
- Add checkpoint resume UI support for long-running AgentEngine sessions.
- Preserve active run subscriptions across session restore and session switch
  flows.
- Render explicit failed tool payloads such as `ok: false` as tool errors in
  live streams and restored session history.
- Improve Markdown preprocessing for malformed model-generated GFM tables,
  including isolated pipe noise before table headers.
- Build release artifacts for `dist-ksadk`, `dist-hosted`, and `dist-lib`.
- Add GitHub Actions npm publishing through Trusted Publishing so releases can
  be pushed without long-lived npm tokens.
- Make the npm publish workflow idempotent when the exact version already
  exists on npm.
