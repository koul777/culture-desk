# Three-cycle browser lifecycle smoke

`browser-lifecycle-smoke-02.json` passed exactly three cycles on `candidate-wave18-popup-focus`. This is functional/cleanup validation and a short workload observation, not a leak verdict or performance acceptance test. The 60-minute run has not been started.

## Readiness correction and preserved failure

Smoke 01 failed before cycle 1 because the first network drain preceded lazy-image loading. At the decode assertion no matching saved image was yet complete; immediately afterward the failure record showed 24 pending image requests/routes. All 29 requests completed during cleanup, including four saved raster replays, and all owned processes exited. Its JSON, worker JSON, NDJSON, and partial report remain unchanged.

The only subsequent harness correction was a bounded 10-second wait for a real saved-raster URL image with `complete && naturalWidth > 0`, followed by drain and the existing decode/dimension checks. It does not force extra image requests or replace API responses. `npx.cmd tsc --noEmit` exited 0 before smoke 02. Product files/tests were not changed.

## Smoke 02 observations

Supervisor: 2026-10-18 19:15:11.304–19:15:41.633 UTC (30.329 s). Worker setup was 3.177 s; active cycles totaled 17.118 s. Pause time was zero.

| Cycle | Full popup scan | Elapsed | Worker user + system CPU | Renderer task duration | Unmount observation |
| --- | --- | ---: | ---: | ---: | --- |
| 1 | Yes | 6.226 s | 0.734 s | 4.337 s | 37 RAF, 611.4 ms |
| 2 | No; pages 1/2 checked | 4.574 s | 0.516 s | 3.030 s | 37 RAF, 605.3 ms |
| 3 | Yes | 6.315 s | 0.547 s | 3.856 s | 37 RAF, 609.8 ms |

Renderer task durations are CDP activity counters, not whole-browser CPU. Worker CPU excludes Chromium and the fixture. The sums correspond to about 10.5% of one CPU for the worker and renderer task activity over about 65.6% of active cycle time; this workload is appreciable and should not overlap a precision benchmark.

All complete map/search/detail wire checks and original IDs/order passed. Total remained 5,649, located marker membership 5,624, and the selected dense popup contained its original 210 members. Local pagination/search/detail return/reopen preserved behavior. Each card-state observation had 2,040 live DOM elements and zero maps, markers, popups, or open dialogs.

All 116 browser requests completed. Eight were API responses: one initial search, three map entries, three details, one bootstrap. Four saved rasters and 99 declared local placeholders were served. Unexpected external requests, failed requests, canceled images, fulfill-abort exceptions, and request overflow were zero. Maximum pending counts were 24 requests, 24 route handlers, and one API validation task; all drained to zero.

Natural-GC card-state samples were:

| Cycle | JS heap used | CDP nodes | CDP listeners | Weak candidates still observable |
| --- | ---: | ---: | ---: | ---: |
| 1 | 16.78 MiB | 14,116 | 5,786 | 2 |
| 2 | 21.21 MiB | 9,542 | 4,927 | 2 |
| 3 | 32.08 MiB | 20,824 | 10,794 | 4 |

Six candidates were observed and two had been collected by cycle 3. These values include uncollected detached objects. Three cycles do not establish a sustained lower envelope, retention cause, or absence of leaks.

## Cleanup, invariants, and possible longer run

Worker PID 32328, Chromium PID 35088, and fixture PID 49804 all exited; supervisor `survivingOwnedPids` is empty. CDP/context cleanup succeeded, pending request references were zero, and no fallback process-tree kill was needed.

Before/after hashes matched:

- Source: `82f3e500a7df24307da75da9030db2db5bea818be75595d4dd4020bc8c776179`
- Client: `f90479edaf65a0e81c5bb8cd9b1020f4680af6b20b13b21b1e3c21baba62a965`
- Harness: `1fae8c44627474811ef3f3799a0557aa1b275e06b637da85975fde7f2901a5ad`
- Snapshot: `09577634afcd8ebdd244053a92d68e1ff944abe9bcebe8cf5ab364e68d86e473`
- Saved raster manifest: `6bb3e752e8874d106a6b3bfdaf71ba3090f1f02d6735ed775f02fa4c60b50736`

Using even the shortest observed cycle gives about 787 cycles per active hour. The 1,200-cycle safety cap therefore appears compatible with this workload, with no padding or cap increase proposed. This is an estimate from three cycles, not a guaranteed runtime rate. The longer mode scans all popup pages every twentieth cycle, then performs an explicit final full scan/unmount/drain after crossing 60 active minutes. That final check has its own duration, excluded from `activeMs` and included in wall time.

A longer run could examine the still-unknown natural-GC trend and repeated cleanup behavior. It remains subject to the coordinator's explicit launch decision and a runtime slot that avoids precision comparisons.

Evidence: [supervisor result](browser-lifecycle-smoke-02.json), [worker result](browser-lifecycle-smoke-02-worker.json), [per-cycle NDJSON](browser-lifecycle-smoke-02.ndjson), [preserved first failure](browser-lifecycle-smoke-01.json), [source protocol](browser-lifecycle-protocol.md).
