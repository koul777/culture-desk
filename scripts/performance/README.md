# Offline performance and semantic verification

The core harnesses use the real published snapshot and application handler without collection, deployment or upstream requests. The optional, explicitly invoked poster acquisition supplement is the bounded network exception described below; all replay measurements remain offline. Run from the workspace root with Node and installed dependencies. Browser commands require a production client build in each selected root and installed Playwright Chromium.

## Distinct measurements

- `startup.ts`: a new Node process per sample. `firstBodyReadySinceProcessStartMs` is measured in the child immediately after reading the complete response body, before JSON/Excel verification. `importMs`, `firstResponseMs`, and parent `processElapsedMs` are separate. The last includes process launch, verification, and exit. OS filesystem caches are **not** flushed.
- `api.ts`: snapshot/model/router already prepared. Miss mode clears only completed response cache values and byte accounting; it asserts no pending operation and exactly one producer. Hit mode asserts zero producers for the exact same request. URL noise and HEAD requests are not used to fake misses. Timings end after body bytes are read; semantic hashing happens afterward.
- `phases.ts`: an observer-enabled attribution probe of SQL/decode/project/budget/serialization. Observer overhead, especially per-marker budget measurement, means this is not an acceptance latency distribution.
- `browser.ts`: a fresh browser context for every sample, a prepared model/router, gzip HTTP, and the selected cache mode. Full published data and coordinates are rendered. Saved date filters deliberately span the snapshot coverage. Map readiness requires actual full-map API response totals, the matching located-item marker sum, a nonbusy results region, and two stable animation frames. Leaflet's initial object creation alone is not ready.
- `semantic.ts`: independent baseline and candidate processes compare complete response semantics across filter, paging, map, detail, invalid-input, HEAD, readonly-mutation and Excel cases. It writes full payloads under ignored `data/` and concise hashes/diffs under the requested output path.

The browser harness replaces known poster images and map tiles with deterministic SVGs and blocks all other external traffic. It measures actual content/geometry/DOM, but not real poster decode, external latency, tile delivery or representative GPU workload. `limited` adds explicit Chromium 4× CPU and 100 ms / 1.6 Mbps download network emulation; it is a reproducible profile, not a claim about a particular phone.

## Commands

```powershell
# Single variant prepared-model API probe, explicit true misses and hits.
node --import tsx scripts/performance/api.ts --root . --samples 30 --warmup 5 --routes national-search,national-map,regional-search,regional-map --out docs/verification/performance-20261019/api.json

# Two isolated prepared workers, sequential AB/BA requests and three drift blocks.
node --import tsx scripts/performance/api-compare.ts --baseline data/performance-session-20261019/baseline --root . --samples 100 --warmup 5 --out docs/verification/performance-20261019/api-paired.json

# Paired cold processes: 50 baseline and 50 candidate samples, AB/BA order.
node --import tsx scripts/performance/startup.ts --root data/performance-session-20261019/baseline --compare-root . --samples 50 --warmup 2 --out docs/verification/performance-20261019/startup-paired.json

# A first-export route can be measured separately to reveal work deferred by lazy imports.
node --import tsx scripts/performance/startup.ts --root . --samples 10 --route '/api/export.xlsx?from=2026-10-01&to=2027-01-17&cities=yeosu,wonju' --out docs/verification/performance-20261019/first-export.json

# Paired real snapshot browser startup and interaction. Build both roots before comparison.
node scripts/performance/host-info.mjs --samples 6 --interval 5000 --out docs/verification/performance-20261019/host-browser.json
node --import tsx scripts/performance/browser.ts --root data/performance-session-20261019/baseline --compare-root data/performance-session-20261019/candidate-wave2-browser --samples 40 --warmup 2 --device desktop --profile local --ambient-evidence docs/verification/performance-20261019/host-browser.json --out docs/verification/performance-20261019/browser-paired.json

# Inspect raw totals, cache producer assertions, source/build stability and three drift blocks.
node scripts/performance/inspect-browser.mjs docs/verification/performance-20261019/browser-paired.json

# Exact before/after response semantics (not a timed acceptance run).
node --import tsx scripts/performance/semantic.ts --baseline data/performance-session-20261019/baseline --root . --out docs/verification/performance-20261019/semantic.json

# Synthetic scale corpus; refuses to overwrite an existing file.
node --import tsx scripts/performance/scale-snapshot.ts --rows 11298 --coordinates preserve --out data/performance-session-20261019/scale-11298.json --manifest docs/verification/performance-20261019/scale-11298-manifest.json

# Explicit override is supported by browser.ts/browser-server.ts and api-compare.ts.
node --import tsx scripts/performance/browser.ts --root . --snapshot data/performance-session-20261019/scale-11298.json --variant scale-11298 --samples 1 --scenarios direct-map --out docs/verification/performance-20261019/scale-11298-browser.json

# A compact 100,000-row boundary corpus stays within the artifact byte contract.
# It preserves required fields, not all real detail content; label it synthetic/minimal.
node --import tsx scripts/performance/scale-snapshot.ts --rows 100000 --minimal true --coordinates preserve --out data/performance-session-20261019/minimal-100000.json --manifest docs/verification/performance-20261019/minimal-100000-manifest.json

# A separate wide Unicode fixture reaches the map byte cap before the item cap.
node --import tsx scripts/performance/scale-snapshot.ts --rows 6 --wide-characters 160000 --out data/performance-session-20261019/wide-6.json --manifest docs/verification/performance-20261019/wide-6-manifest.json
```

Run latency acceptance with an exclusive measurement window: no parallel build, unit-test suite, browser run, profiler or workload. Save raw data and the exact source/snapshot fingerprints. API/startup fingerprints scope server/shared/package files; browser fingerprints also include web source and every production client asset. A source or client build change during measurement fails the run. Keep baseline and candidate production builds aligned with their sources. Paired browser mode uses two prepared fixture processes and sequential AB/BA samples with fresh contexts; it never overlaps browser samples. Warmups are retained separately and excluded from quantiles.

All quantiles use nearest rank. With fewer than 20 samples p95 is the maximum; small probes locate bottlenecks and do not establish a reliable tail-latency win. Paired startup, API and browser reports retain three temporal blocks to expose drift. The 13–14 sample blocks in a 40-pair browser run are drift diagnostics, not independent tail claims. A single same-process run cannot establish fresh-process startup behavior.

JSON semantic hashing sorts object keys but preserves array order and every value, including `snapshotAt`, `published`, partial/coverage flags and counts. Excel comparison preserves all worksheet values/styles/formats and sheet geometry/views/filters. Only the validated `조회 근거!B2` extraction timestamp is normalized; workbook creation and ZIP timestamps are recorded or excluded as per-read metadata. Snapshot timestamps elsewhere remain exact. Transport Date and Content-Length are excluded from semantic header equality; response status and other headers are compared.

Fixture startup has a deadline and cleanup covers browser-launch and setup failure. Browser failures save completed sample data and the error in a `.failure.json` file. Long browser endurance runs must disable opt-in instrumentation or clear User Timing/long-task entries between iterations, so the measuring tools do not create the apparent memory leak.

Scale fixtures cycle real content and assign unique IDs/source IDs. `preserve` repeats the original venue distribution; `dense` puts every row at one coordinate, `spread` uses a synthetic grid (including offshore points), and `missing` removes coordinate precision. These three coordinate overrides are adversarial geometry cases, not real venues. Preserve the generator manifest and source SHA. Larger fixtures must retain totals/partial/source metadata, and any map truncation must obey both the 10,000-item and 3 MiB UTF-8 response limits while remaining visible in the UI.

Before a controlled run, coordinate an exclusive window and inspect ambient host state. `node scripts/performance/host-info.mjs` records a one-second CPU utilization probe, free memory, and selected process working sets. It does not stop user processes. A host/resource failure or extreme drift should pause acceptance measurements; concurrent diagnostic results remain labeled diagnostic. API paired samples also record process CPU time separately from wall time.

## Optional bounded poster supplement

`poster-corpus.ts` is the explicit exception to the offline-only rule: it selects at most eight public-snapshot poster URLs intersecting the first cards viewport, then fetches each once with a 5 MiB / 30 second limit. Run acquisition outside a benchmark window. It refuses an existing manifest, records failures without retries, and preserves exact bytes, URLs, status, type, hash and decoded dimensions under ignored `data/`.

`poster-replay.ts` then runs offline AB/BA pairs using those exact bytes. It retains the original DOM-ready endpoint and separately waits for visible image decode and stable image/card rectangles. The additional post-DOM wait includes any remaining fetch/decode work; it is not isolated decoder CPU time. Local replay does not reproduce image CDN latency or Internet throughput. See `docs/verification/performance-20261019/poster-protocol.md`.

Corpus v2 rejects SVG and requires a matching raster signature/MIME plus decoded dimensions. Replay records actual fulfillment URL/hash, verifies producer misses from response headers, and checks route settlement after context cancellation. Partial reports retain provenance and are saved before bounded browser/fixture cleanup. A failed or incomplete run remains at its requested output path with `complete: false`; do not treat its partial summary as acceptance evidence.

```powershell
node --import tsx scripts/performance/poster-corpus.ts --root data/performance-session-20261019/candidate-wave2-browser --device desktop --out data/performance-session-20261019/posters-01/manifest.json
node --import tsx scripts/performance/poster-replay.ts --root data/performance-session-20261019/baseline --compare-root data/performance-session-20261019/candidate-wave2-browser --manifest data/performance-session-20261019/posters-01/manifest.json --samples 2 --warmup 0 --device desktop --out docs/verification/performance-20261019/poster-replay-probe.json
node --import tsx scripts/performance/poster-replay.ts --root data/performance-session-20261019/baseline --compare-root data/performance-session-20261019/candidate-wave2-browser --manifest data/performance-session-20261019/posters-01/manifest.json --samples 2 --warmup 0 --device mobile --scroll first-result --out docs/verification/performance-20261019/poster-mobile-scroll-probe.json
```
