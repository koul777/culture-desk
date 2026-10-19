# KST day-boundary freshness regression

The same published artifact can produce different `upcoming`/`ongoing`/`ended` results after Korean midnight. The server cache already invalidates by `today()`, but the browser's result signature omitted `boot.today`. A successful bootstrap refresh updated the displayed date and status badges without rerunning list/map requests. The existing publication-refresh regression changed `published.snapshotAt`, so it did not cover this case.

A new isolated browser regression reproduced the failure against the existing pin10 build: after the day changed, observed requests were **bootstrap 1 / search 0 / map 0**, rather than 1 / 1 / 1. `web/App.tsx` now includes `boot.today` in the existing signature. User-selected period/status values are unchanged.

The regression uses browser time 2026-10-18 14:59:59Z → 15:00:01Z (KST midnight). Explicit route fixtures keep publication identity, source counts and run state fixed. With an `ongoing` filter, A ends on October 18, B starts October 19, and C spans both days. The expected ordered result changes from A,C to B,C with the same total of two.

After the one-field signature change, the build/typecheck and single browser test passed. It confirms one list and one full-map refresh, the new B,C popup membership, removal of A, preserved period/status/localStorage, and no extra list/map requests after a second same-day bootstrap read.

**Scope:** Playwright's fixed clock affects the browser, not the Node fixture server. Explicit route oracles test UI invalidation; this is not a test of the server clock or a real-time wait across midnight. Existing cache day-invalidation unit coverage remains separate. No snapshot, fixture-data file, or date-format implementation was changed.

- Regression: `tests/e2e/freshness.spec.ts`
- [Failure before correction](kst-freshness-before.txt)
- [Build/typecheck](kst-freshness-build.txt)
- [Single regression pass after correction](kst-freshness-after.txt)
- Before-fix screenshot/trace: `test-results/freshness-before/`

This changes the UI after pin10; final source/client pinning and the integrated quality run must include it together with any subsequent fixes.
