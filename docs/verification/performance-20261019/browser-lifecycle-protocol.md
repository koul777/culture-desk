# Browser lifecycle protocol

This diagnostic covers client map/popup creation, local interaction, removal, and re-entry. It does not repeat the API-cache or Excel endurance checks and is not a latency benchmark.

The three-cycle smoke passed. The subsequent 60-active-minute attempt stopped after 239 completed cycles and 16.27 active minutes following a long observation gap and a network suspension error. It did not complete the protocol. See the [smoke assessment](browser-lifecycle-smoke-assessment.md) and [interruption handoff](browser-lifecycle-interruption-01.md); the procedure below does not imply a successful endurance result.

## Inputs and authorization

- Pass the fixed source/client pin supplied after popup CI and the mobile matrix. Do not use an actively changing workspace or change an older pin.
- Use the unchanged 5,649-row snapshot and `data/performance-session-20261019/posters-01/manifest.json`.
- The default `smoke` mode executes exactly three cycles. The implemented `soak` mode is a separate, 60-active-minute run and needs the coordinator's explicit launch decision after smoke.
- Validation outcomes, actual workload and cleanup results are recorded separately from this procedure.

Initial command, with the actual fixed pin and a new output name substituted:

```powershell
node --import tsx scripts/performance/browser-lifecycle.ts --root data/performance-session-20261019/FIXED-POPUP-PIN --manifest data/performance-session-20261019/posters-01/manifest.json --out docs/verification/performance-20261019/browser-lifecycle-smoke-01.json --mode smoke
```

## Workload and correctness

One Chromium, context, and page persist throughout the series. API search/map/detail responses are never replaced. The loop uses the real national map and the real result-page locate button to open a dense coordinate group; the closer first member of the actual 210/112-member groups bounds initial pagination to at most 20 pages.

Each cycle enters the map, verifies the weighted marker count, locates the chosen real item, checks local popup pagination and title search, opens/closes a real detail, verifies focus returns to the same row, closes/reopens the popup by keyboard, and returns to cards. All pages of the chosen group are enumerated on cycle 1, every twentieth cycle, and the last smoke cycle. Other cycles check pages 1 and 2. IDs and order are compared with the unchanged snapshot. Local popup actions must not refetch search/map results. After unmount, the observer requires both at least 32 animation-frame callbacks and 600 ms to pass, checking absence of map/popup/dialog elements before the first callback and after every callback. Both conditions must finish within the existing 3-second deadline. This covers the controller's bounded 30-frame retry without assuming 60 FPS; a renderer too slow to meet the observation deadline fails the diagnostic but does not by itself prove a product cleanup defect. Actual frame count and elapsed observation time are recorded for each completed cycle and final verification.

After the soak crosses 60 active minutes, it performs an explicit final map entry, complete popup ID/order scan, unmount observation, and request drain. `finalVerificationMs` is separate and excluded from the already-complete `activeMs`; wall time includes it. This final verification also respects a pause request before entering the map.

Actual repeated API bodies are SHA-256 compared by canonical URL. Total, source counts, date/filter values, result order, map truncation/byte cap, snapshot timestamp, and detail identity are checked independently. Browser errors, unexpected HTTP responses/external requests, and undrained work fail the run. Canceled image requests (`net::ERR_ABORTED`) are counted separately because Leaflet can discard old tiles on zoom/removal; API cancellation is not silently accepted.

The route-handler catch accepts only an allowlisted image in its `fulfill` operation when that exact Request independently reports terminal `net::ERR_ABORTED`. Such races preserve the bounded error text in NDJSON and a scalar count. Unconfirmed errors, API/continue errors, and validation errors still fail; no broad error-message allowlist is used. The installed Chromium Playwright implementation already absorbs most protocol cancellation races, so the smoke will establish whether this fallback occurs at all.

Saved poster URLs replay verified raster bytes and dimensions; at least one loaded saved raster must actually decode. Other known posters and OpenStreetMap tiles use a declared local SVG substitute. Every other external browser request is blocked, and the existing fixture prohibits server outbound fetch. This is not a claim of full real-image or provider rendering coverage.

## Bounded observation

- Pending Request references: 256; route handlers: 256; asynchronous API-body checks: 8; unique wire oracles: 128.
- Recent in-memory rows: 100. Full measurements append to NDJSON instead of accumulating in an array.
- Removed map/popup candidate WeakRefs: 256, with WeakSet deduplication. No persistent ElementHandle is retained; the one detail-return handle is disposed in `finally`.
- Resource Timing buffer: 150; cleared after card-state samples. Product performance collectors and trace/HAR recording are not enabled.
- Maximum 1,200 cycles, asserted rather than silently truncating a 60-minute run. Smoke determines whether this safety cap is compatible with the observed interaction duration; do not add idle waits to make it fit.

Natural-GC CDP heap/DOM/listener counters are sampled after each removal and at map/popup phases on cycle 1 and every fifth cycle. The pre-map/module-load baseline is distinct from warmed post-cycle card samples. Fixed five-minute bins retain count/min/max/sum. Each cycle records elapsed time, actual worker CPU delta, renderer task/script/layout/style counter deltas, and request/API counts. These measurements from all three smoke cycles determine the workload/cap decision; no preset load is claimed. Worker CPU explicitly excludes Chromium and fixture CPU, while CDP task durations are renderer activity observations rather than whole-browser CPU or peak memory.

DOM counters can include uncollected detached nodes, and WeakRefs only observe bounded candidates. No forced GC, leak-detection preparation, heap snapshot, retained-path proof, or “no leak” conclusion is part of this harness. Memory lower envelopes require later interpretation with those limits.

## Time, pause, failure, cleanup

There is no idle delay to reach an elapsed-time target. Actual cycles determine load; the pre-smoke estimate is not an acceptance result. Optional `--control <path>` reads `{ "paused": true }` between cycles in the card state. Paused time is excluded from active time; normal app bootstrap activity can continue and remains counted. Worker walls are five minutes for smoke and 90 minutes for soak, including setup; the separate supervisor watchdog adds two minutes for outer failure handling.

The supervisor owns the fixture ChildProcess and Playwright BrowserServer separately from the worker. On timeout or interruption it saves partial paths/results, terminates only those owned handles, and on Windows may use `taskkill /PID <owned pid> /T /F`. It never enumerates or terminates other browser/Node processes. The worker closes its observer, CDP session, context, and browser connection and releases pending Request references. Teardown drain counts and surviving owned PIDs are reported; cleanup failure fails the diagnostic.

Source/client/snapshot/manifest/harness fingerprints are fixed before and after; saved raster hashes are rechecked. Existing outputs are refused. A supervisor JSON, worker JSON, append-only NDJSON, and partial supervisor report preserve failure evidence. Initial fixture/browser setup errors can occur before a worker report exists; the supervisor still records them and performs owned cleanup.
