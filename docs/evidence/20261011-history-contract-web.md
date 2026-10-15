# 2026-10-11 Web history contract verification

## Scope

This branch preserves message and event history provenance through the hosted
action API and embedded `ApiFacade`, stores both pagination contracts, carries
`CursorSource`, `HistoryEpoch`, and `SnapshotSeqId` on continuation reads, and
shows a persistence warning. A 409 `HISTORY_RELOAD_REQUIRED` clears stale
pagination and makes one fresh first-page read. The visible transcript remains
until that read succeeds; a failed reload leaves it visible with an error.

`SnapshotSeqId: 0` is retained. Empty visible message pages may still advance
`NextCursor` and `HasMore`. Event pages use their own source and snapshot;
events from a different source or epoch are not mixed into messages. The
ordinary first-page transient retry excludes 409 reload and 422 projection
budget errors. Live `AfterSeqId` reads do not inherit a history snapshot.

## Reproduction

From this `ksadk-web` worktree, with dependencies installed:

```sh
npm test
npm run build:lib
npm run build
npx playwright test --config playwright.history-contract.config.mjs
```

Observed: 80 Vitest files / 861 tests passed; both builds passed; seven Chromium
Playwright cases passed. The browser suite checks the degraded persistence
warning, continuation source/epoch/zero snapshot, empty visible continuation,
409 reload success and failure, the one-reload limit, session-switch isolation,
an expired or late event page, and aborting an in-flight reload.

The Playwright suite runs real Chromium and the real React components and API
client against `page.route` JSON API fixtures. It verifies browser behavior,
not Server, Gateway, Runtime, or PostgreSQL behavior.

## Hosted package consumer check

The local `npm pack` artifact is
`/tmp/ksadk-web-history-contract-20261011/kingsoftcloud-ksadk-web-0.3.12.tgz`.
A `git archive` copy of `agentengine-hosted-ui` is at
`/tmp/ksadk-web-history-contract-20261011/hosted-ui`. The original hosted
repository was read only. In that copy, the tarball was installed without
saving a dependency or lockfile change:

```sh
npm install --offline --no-save --package-lock=false --ignore-scripts /tmp/ksadk-web-history-contract-20261011/kingsoftcloud-ksadk-web-0.3.12.tgz
npm run build:hosted
npm test
```

Observed: installed package version 0.3.12, hosted build passed, all 14 hosted
shell tests passed. A separate Chromium smoke check opened the built bundle at
`/hosted-ui/chat/` through a temporary static server and the canonical
conversation HTTP fixture. It returned HTTP 200, rendered `Canonical Fixture`,
and had no page errors. This verifies package consumption and page loading;
the API fixture is mocked, and no full database or cross-service acceptance is
claimed here.

No package was published, pushed, deployed, or merged.
