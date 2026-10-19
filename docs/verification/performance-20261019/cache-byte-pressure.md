# Published response cache: byte-pressure integration check

The existing six cache tests already cover entry/byte LRU order, oversize/non-JSON bypass, concurrent body ownership, error retry, day rollover with old pending work, snapshot isolation and GET/HEAD. The mixed long-running workload reached the 32-entry limit but retained only about 3.43 MB. It did not exercise the default 16 MiB byte limit with large real-handler responses.

This additional **finite 24-request functional check passed**. It uses pinned `candidate-wave7-publication` and the unchanged, valid `minimal-100000.json` artifact. The fixture has 100,000 synthetic records with required fields; it is not 100,000 full original records. Outbound fetch is prohibited. Production files were not changed.

Three bursts contain eight requests each: eight distinct large map misses; an evicted key requested twice alongside HEAD, a hit and four new keys; then another eviction retry, repeated hits and HEAD. Keys use valid source filters and expanded date ranges. Map bodies are 2,206,990–2,304,931 bytes, rather than the full 3 MiB allowance.

| Check | Observed result |
|---|---|
| First eight bodies together | 18,047,682 bytes, above 16,777,216-byte limit |
| Entries after that burst | 7, proving byte eviction before the 32-entry limit |
| Maximum observed retained bytes | 15,840,692 |
| Requests / cache reads / HEAD | 24 / 21 / 3 |
| Cache producers / hits / joins | 14 / 5 / 2 |
| Maximum simultaneous pending keys | 8 |
| Pending keys after each burst | 0 |
| Whole-database hash and `total_changes()` | Unchanged |

At each cache-read completion and each consumed response, accounted bytes equal the sum of retained buffer lengths, every retained buffer matches its expected hash, and limits hold. Every GET has exact expected wire bytes and its own Response object; every HEAD has zero body bytes and the same required published/security headers. HEAD never enters the GET cache. Repeated cold GETs share one producer after eviction.

The uncached oracle filters/sorts the original artifact directly and combines those rows with ordinary paged-search metadata, then applies the existing marker/response-budget function. It bypasses compact map SQL, its large-result row bound, HTTP and response caching. This isolates cache integration/body ownership; it is not an independent reimplementation of the previously tested map budget.

`query_only=1` was checked throughout. Schema and all table rows were hashed incrementally before/after, avoiding a second whole-database JSON allocation. Both hashes were `97a7ff78eb9653cbb6436741f7c68ec4bfcdc3a1b1b8da19ff27bff22f3eb884`, and total changes stayed 100,691. Source fingerprint stayed `1182810ff91e22bae034b181c8285451dc3635dd5418bcdc6dac17aac7c094a7`; harness files also remained unchanged. A separate child process had a 90-second external watchdog and completed in about 11.5 seconds.

This closes the identified finite byte-pressure integration gap. Concurrent soaks were running, so recorded elapsed times are diagnostic only. There is no latency, peak-memory, or long-duration stability claim and no need to repeat existing unit cases or extend this into another timed soak without a new hypothesis.

- [Full assertions, per-request hashes, cache accounting and source fingerprints](cache-byte-pressure-01.json)
- [Reproducible finite harness](cache-byte-pressure.ts)
- Existing coverage: `tests/published-response-cache.test.ts`
