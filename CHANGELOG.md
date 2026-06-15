# Changelog

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
