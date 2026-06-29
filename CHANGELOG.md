# Changelog

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
