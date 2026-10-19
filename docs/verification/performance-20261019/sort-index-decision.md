# Additional sort index: rejected

The single candidate `CREATE INDEX experiment_performances_order ON performances(classification,start_date DESC,id DESC)` is **not recommended for production**. On the actual 5,649-row corpus, its national-map median saving was only 4.56 ms and inconsistent across the five pairs. Both regional conditions regressed in every pair. No production SQL, schema, source, or original data was modified.

## Controlled variables and limits

The experiment used pinned `candidate-wave11-selection`, server/shared source fingerprint `7dbf937c06e6b6ddbd6d3ebad70c7b72cbc722b182fc40ccc23923a040b1b3bb`. Separate private in-memory models retained every original index and constraint; the candidate added exactly one index **after** validated insertion and **before** `query_only=ON`. There was no `ANALYZE`, forced `INDEXED BY`, or modification of the artifact.

Eight map conditions produced 80 measured no-trace Fastify responses: five alternating A/B pairs per condition, after one warm-up pair. Exact body bytes, status, headers except wall-clock `Date`, and metadata matched. The actual corpus also passed all five paged-search conditions. SQL plans were captured in a separate untimed functional pass, with the original native `prepare` method restored before timings. A separate single instrumented pass records phase attribution; those events are not mixed into the no-trace series.

These are small diagnostic samples, not p95 or deployed HTTP latency acceptance. Artifact parsing, module imports, network transport, the cloud envelope and response cache are excluded. Natural GC and host variability are visible in the raw samples: actual national original ranged from 64.42 to 215.88 ms. Request order alternates within each pair, but the observations do not establish stable population percentiles. The plan change and five-of-five regional regressions are sufficient to reject this candidate without a larger acceptance run.

## Complete route observations

All values below are milliseconds, five samples per variant. “Faster pairs” means candidate faster than original within the same round.

| Corpus / map condition | Original median | Candidate median | Faster pairs |
|---|---:|---:|---:|
| Actual 5,649 / national | 173.16 | 168.60 | 3 / 5 |
| Actual / single region, 31 rows | 3.17 | 8.12 | 0 / 5 |
| Actual / two regions, 51 rows | 3.53 | 9.12 | 0 / 5 |
| Actual / music genre, 3,046 rows | 126.19 | 149.93 | 1 / 5 |
| Actual / free + all ages, 55 rows | 75.69 | 73.88 | 3 / 5 |
| Repeated actual content 22,596 / national | 426.48 | 371.16 | 4 / 5 |
| Minimal synthetic 100,000 / national | 590.25 | 556.10 | 4 / 5 |
| Minimal synthetic / two regions, 902 rows | 26.27 | 232.82 | 0 / 5 |

The national actual response remained 1,654,588 bytes and 5,649 markers. Both large national responses remained the same ordered 10,000-marker prefix with `truncated:true`, at 2,946,281 bytes (22,596) and 2,214,704 bytes (100k minimal), within the existing 3 MiB budget. The 100k fixture has reduced required-field content; this is not a claim about 100k original full records.

## Why the regression occurs

Before the candidate, regional row reads use `performances_search (classification=? AND city_id=? AND start_date<?)` and sort the selected rows. After adding the candidate, SQLite keeps that selective index for regional counts but chooses `experiment_performances_order (classification=? AND start_date<?)` for the marker rows. It avoids the sort by scanning the national ordering and then checking the city filter. No forced planner hint was applied.

For national queries the new index removes the full projection's temporary ordering B-tree. Above the current 20,002-row cutoff it removes the narrow CTE's inner sort, while the final 10,001-row ordering B-tree remains. The old inner scan was covering for the date selection; the new index lacks `end_date`, so it requires table lookups. It also changes national count-query index selection. Thus removing a sort is not equivalent to reducing the whole request cost.

The separate single trace pass corroborates the regional row-query change: actual single-region `search.rows` was 0.92 versus 6.90 ms; minimal-100k two-region was 11.40 versus 186.22 ms. These individual trace values are attribution, not a second latency series.

## Startup and space costs

The actual corpus had five fresh-model pairs, including the first models used for warm reads. Additional models were closed before proceeding. Larger fixtures used only their necessary first construction pair. This is model creation inside an already imported process, not a fresh-process startup benchmark; initial Fastify setup/JIT and model retention can affect the first pair.

| Corpus | Candidate post-load index build | Additional allocated SQLite pages |
|---|---:|---:|
| Actual 5,649 | median 9.57 ms; range 6.34–11.23 | 192,512 bytes (188 KiB) |
| Repeated actual 22,596 | 21.99 ms; one observation | 757,760 bytes (740 KiB) |
| Minimal synthetic 100,000 | 235.91 ms; one observation | 3,473,408 bytes (3,392 KiB) |

The actual setup + validated insert + index build + first route median was 601.22 ms original and 659.05 ms candidate. Insertion/setup variability prevents attributing that entire difference to the index. The directly measured added build stage and page allocation are separate costs. Observed process memory points are not peak-memory measurements.

This post-load construction experiment also does **not** measure placing the same index in the generic Store constructor: that would maintain it during every inserted row and affect collector writes. No practical rollout location is proposed because the warm regional regression already fails the acceptance condition. A break-even request count would be misleading given the inconsistent small actual national saving and slower regional misses; response-cache hits receive no benefit.

## Integrity and failure evidence

Every worker exited normally after closing its owned applications and databases. The two models used for read comparisons in each fixture had their complete original table/row hash, `total_changes`, index definitions and `query_only=1` checked before and after those reads. Additional actual-corpus startup models verified their first response and read-only state; they did not repeat the full table-hash pass. Source and harness fingerprints and all original artifact byte hashes stayed identical.

The first attempt stopped before timing the repeated corpus because two fresh models' `schema_migrations.applied_at=datetime('now')` differed across a wall-clock second. The failed report is preserved. The corrected attempt normalizes **only** that constructor timestamp for cross-model comparison, retains the actual migration rows in evidence, and still compares each individual model's unnormalized raw hash before versus after. No data was edited to satisfy this check.

- [Completed experiment](sort-index-02.json)
- [Actual corpus, plans, all samples and cold stages](sort-index-02-runs/actual.json)
- [22,596 repeated corpus](sort-index-02-runs/repeated.json)
- [100k minimal corpus](sort-index-02-runs/minimal.json)
- [Initial harness failure](sort-index-01.json.failure.json), [failed repeated-corpus report](sort-index-01-runs/repeated.json)
- [Experiment source](sort-index-diagnostic.ts)

The runtime slot was returned after the final worker exited. No additional benchmark or production change is required for this rejected candidate.
