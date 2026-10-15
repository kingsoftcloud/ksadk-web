# Progressive history follow-up validation

The follow-up fixes preserve live turns during a 409 reload, keep paged tool details when feedback changes, and retain the pagination lock throughout preparation/cancellation.

- 976 frontend tests, 128 Node contract tests and 9 history-contract browser tests passed; type checking, targeted lint and both SDK/hosted builds passed.
- Two additional Chromium cases use actual loopback Server/Gateway/Runtime responses with PostgreSQL, comparing ordered API text with the client store and checking visible messages across pagination and session switches. Both candidate and released Runtime paths passed these browser cases.
- The backend large-history mixed read/write acceptance did **not** pass for the historical Runtime. Backend performance must be resolved before this combined change is accepted. A successful frontend CI run is not a substitute for that acceptance.

The branch retains all original #27 commits. #28 is a draft successor because the original fork does not allow maintainer edits. No version bump, release or deployment is included.
