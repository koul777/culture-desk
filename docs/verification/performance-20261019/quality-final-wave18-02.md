# Integrated quality — wave18

`npm run quality` passed: TypeScript, **309/309 unit tests across 50 files**, production build, and **16/16 Chromium scenarios**. All 16 browser guards report zero runtime errors and zero unexpected requests; no browser cases were skipped or flaky. The desktop project contains 15 cases, including the dedicated 375px popup case, and the separate mobile project contains one flow.

| Step | Result | Duration |
| --- | --- | ---: |
| TypeScript | PASS | 3.3 s |
| Unit tests | 309/309 PASS | 40.8 s |
| Production build | PASS | 23.2 s |
| Chromium | 16/16 PASS | 100.9 s |

The new regression verifies that Tab or an external pointer action cancels queued popup row focus, while resize/layout updates preserve focus and ordinary pager focus still works. Its map-only controller fixture contains 41 unique rows with source counts matching those rows; the normal server/search fixture remains 36 records.

The first wave18 attempt stopped at TypeScript: the new test used uppercase source comparisons inconsistent with the source type. **No unit tests, build or browser cases ran in that failed attempt.** The test owner replaced the fixed comparisons with actual source aggregation and a total-41 assertion, then passed TypeScript and the focused case. Only `tests/e2e/popup.spec.ts` changed between the two attempt manifests. Product source/build remained unchanged. The failed attempt and the earlier wave17 309-unit/15-browser pass remain preserved.

Before and after this successful full run, all recorded hashes matched exactly:

- Product source: `82f3e500a7df24307da75da9030db2db5bea818be75595d4dd4020bc8c776179`
- Production build: `f90479edaf65a0e81c5bb8cd9b1020f4680af6b20b13b21b1e3c21baba62a965`
- Validation source: `aef6f56b41c89afd29e7571ef6dd1bb0b132f8bcd1e5f52de0d7edec9b30fad2`
- Quality workflow: `67394d9844835128ce65ce64be7406371a17608ae5b478594a8f867f2243d2cd`

The workflow change adds push checks only for `feat/daily-snapshot-deploy`. Read-only contents permission, disabled credential persistence, the same quality command, a 15-minute timeout and no deployment are retained. This local pass does not establish a successful Linux Actions run; that remains a separate remote check.

Evidence:

- [Full console](quality-wave18-02.txt), [step summary](quality-summary-wave18-02.json), [browser report](quality-e2e-wave18-02.json), [combined summary](quality-final-wave18-02.json).
- [Before metadata](quality-wave18-before-02.json) and [after metadata](quality-wave18-after-02.json), including per-file hashes and the unchanged snapshot/config inputs.
- [First-attempt typecheck failure](quality-wave18-01.txt) and [failure summary](quality-summary-wave18-01.json).
- Nine screenshots, each with a hash in the combined summary, are preserved in `quality-wave18-images/`.

This is functional verification using synthetic TEST data and offline tiles, not a latency benchmark or live-provider/browser-engine/GPU guarantee. The existing large Cesium chunk warning remains. The README count/coverage update after validation is documentation only; no further full repeat was run after this pass.
