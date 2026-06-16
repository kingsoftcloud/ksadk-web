# Changelog

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
