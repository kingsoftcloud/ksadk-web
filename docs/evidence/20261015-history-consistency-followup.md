# Progressive history follow-up validation

The follow-up fixes preserve live turns during a 409 reload, keep paged tool details when feedback changes, and retain the pagination lock throughout preparation/cancellation.

- 976 frontend tests, 128 Node contract tests and 9 history-contract browser tests passed; type checking, targeted lint and both SDK/hosted builds passed.
- Two additional Chromium cases use actual loopback Server/Gateway/Runtime responses with PostgreSQL, comparing ordered API text with the client store and checking visible messages across pagination and session switches. Both candidate and released Runtime paths passed these browser cases.
- Initial backend acceptance failed on historical Runtime read timeouts and projection capacity. Those results were retained; the subsequent control-plane fixes and final rerun passed the criteria described below. Frontend CI alone was not used to accept the backend change.

The branch retains all original #27 commits. #28 is the successor because the original fork does not allow maintainer edits. No version bump, release or deployment is included.

## Final mixed-version acceptance

The released 0.8.5 distribution remained unchanged (Python source files checked against its wheel RECORD). The local real-PostgreSQL and HTTP harness passed with the historical Runtime admitted to a bounded control-plane read projection; current Runtime reads retained their native source. No historical SDK upgrade was required.

At 100,000 events, simultaneous reads and 100 actual writes per version returned history-read p95/p99 of 267/353 ms for the candidate and 273/375 ms for the unchanged historical SDK through the control projection (160 reads per version, zero errors). Across six corpora, 220,200 messages and 2,591 pages were audited with no missing or duplicate IDs/content. Both actual-backend Chromium cases passed ordered API/store transcript comparison, pagination and repeated session switching.

This is local acceptance with synthetic approximately 1-KiB events, fixed routing/account fixtures and no model/cloud deployment. First preparation and the historical SDK's execution replay/append costs are separate from warm-page latency. The projection requires operator admission after the control-plane rollout and index migration; merging this PR does not activate a deployment. A failed intermediate projection boundary audit was fixed and rerun before the final pass.
