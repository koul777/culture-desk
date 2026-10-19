# Map selection bound: offline evidence

All 81 approved matrix variants and 90 follow-up crossover variants preserved exact final JSON bytes and semantic hashes. These are SQL/projection attribution and synthetic stress observations, **not HTTP latency acceptance measurements**. A cache stability workload, and later an export stability workload, shared the host. Explicit GC ran before each SQL variant. Only 3 or 5 measured observations per variant were collected; reported p95 fields are sample maxima and do not support a population-tail claim. Memory entries are observation points, not process peaks.

The reference is pinned `candidate-wave4-cleanup`, source SHA-256 `d50e3dc7ef47590d52ea14d1942f8efb919daa47c250b9454a3a4cb16b33bca3`. Source fingerprints remained unchanged and every Store remained `query_only=1`. The same WHERE predicates, `start_date DESC,id DESC` ordering, marker projection and byte-budget function were used for:

1. Existing compact projection of all matching rows.
2. The same SELECT with `LIMIT 10001`.
3. A materialized CTE selecting only ordered IDs/start dates with `LIMIT 10001`, followed by primary-key marker projection and explicit final ordering.

`selectedRows` is the matching SQL COUNT, separately from the unchanged public `total`. Historical Store sources may appear in selected rows/sourceCounts while public total still sums only kopis/culture. No public artifact was altered to introduce unsupported sources.

## Correctness and coverage

| Fixture / selected rows | Returned rows | Truncated | Final UTF-8 bytes |
|---|---:|---|---:|
| Empty / 0 | 0 | false | 173 |
| Minimal / 9,999 | 9,999 | false | 2,203,971 |
| Minimal / 10,000 | 10,000 | false | 2,204,196 |
| Minimal / 10,001 | 10,000 | true | 2,204,197 |
| Wide Korean title/venue / 6 | 3 | true | 2,880,740 |
| Actual-content repeated / 22,596 | 10,000 | true | 2,946,281 |
| Required-field synthetic / 100,000 | 10,000 | true | 2,214,704 |

The whole envelope and separators fit within 3 MiB. Complete title/venue values were preserved; the first non-fitting marker stops the ordered prefix. The existing conservative one-byte difference between `truncated:false` and `true` was preserved.

The 22,596 fixture also matched exactly for regional (204 selected), culture source (5,112), literal text (1,760), admission (220), and bookmarks (0). Published snapshots have no bookmarks; positive bookmarks, historical sources, pending-before-admission metadata, newer incomplete coverage, missing/null fields and byte-cap precedence are covered by the separate Store regression tests.

The 100,000 fixture is 58,800,512 UTF-8 bytes / 58,360,514 decoded code units and passes the existing 64 MiB loader budget. It deliberately removes optional/full detail content. It is **not evidence for 100,000 full original records**. Its source-filter selection is 22,649 rows; regional selection is 902. Text/admission comparisons were omitted for this fixture because its minimal content makes those filters trivially empty.

## Phase observations

Values are per-phase medians in milliseconds; median phases need not sum to the median total.

| Corpus / variant | SQL | Decode | Budget | Serialize | Total |
|---|---:|---:|---:|---:|---:|
| 22,596 full | 137.59 | 16.73 | 10.83 | 10.58 | 175.79 |
| 22,596 LIMIT | 140.73 | 6.70 | 10.43 | 9.86 | 165.93 |
| 22,596 narrow CTE | 77.69 | 6.53 | 8.71 | 9.09 | 102.06 |
| Minimal 100,000 full | 1,003.69 | 165.88 | 11.99 | 14.07 | 1,155.92 |
| Minimal 100,000 LIMIT | 411.27 | 19.80 | 14.61 | 15.87 | 465.51 |
| Minimal 100,000 narrow CTE | 181.05 | 14.26 | 11.68 | 12.90 | 225.05 |

The 100k full total ranged from 609.24 to 1,195.39 ms, demonstrating host-load variability. National EXPLAIN shows the full/LIMIT projection reading `performances_search` and using a temporary ordering B-tree. The CTE's narrow first selection uses the covering index, then reads only the selected primary keys. Plain LIMIT reduced JS decoding but did not consistently reduce SQLite projection cost.

Small-result single observations showed overhead: 22,596-corpus text full 62.28 ms versus CTE 70.47 ms; culture 35.66 versus 38.98 ms. A universal CTE or universal LIMIT is therefore not recommended.

## Crossover follow-up

Five rotated measured observations plus one warm-up round per variant, using prefixes of the actual-content 22,596 artifact:

| Selected rows | Full total median | LIMIT total median | CTE total median |
|---|---:|---:|---:|
| 10,002 | 82.75 | 94.27 | 90.44 |
| 12,000 | 143.29 | 160.39 | 217.20 |
| 15,000 | 122.99 | 138.19 | 112.33 |
| 18,000 | 154.40 | 364.36 | 228.45 |
| 20,002 | 335.38 | 360.90 | 240.31 |

CTE was slower in all five same-round comparisons at 10,002 rows. It was faster in all five at 20,002 rows (full→CTE: 166.78→125.60, 234.48→137.71, 335.38→268.48, 423.97→240.31, 411.74→273.25 ms). At 18,000 it won four same-round comparisons while the medians reversed, so these concurrent measurements cannot identify a precise crossover.

The evidence supports a conservative candidate cutoff of at least twice the sentinel row count (20,002), retaining the existing plan below that point. Counts must use every post-admission source group, rather than known-source public total. This remains a candidate for independent functional review and later isolated performance verification.

The implemented candidate uses `actualSelected >= 2 * MAP_QUERY_ROWS` (20,002). Fourteen focused tests passed, including 20,001/20,002/20,003 selected rows, more than 20,000 positive historical-source bookmarks, and admission filters that move the selected count across the cutoff. Ordinary paged/all-row search and export selection remain unbounded by this map-only option. A second functional comparison with the prior pinned source passed all six real-content filter cases with exact final wire bytes. The current server/shared fingerprint remained `511c91df80844fe1c82dd1613276ed52d059c9d0997b06e721e1eb4af4508aa7` before and after that check. These checks establish correctness, not performance acceptance.

## Artifacts

- [22,596 national phases](map-limit-22596-national-01.json), [six filter cases](map-limit-22596-filters-01.json)
- [100,000 minimal phases](map-limit-minimal-100000-01.json)
- [0 rows](map-limit-empty-0-01.json), [wide UTF-8 values](map-limit-wide-6-01.json), [9,999](map-limit-boundary-9999-01.json), [10,000](map-limit-boundary-10000-01.json), [10,001](map-limit-boundary-10001-01.json)
- Crossover: [10,002](map-limit-crossover-10002-01.json), [12,000](map-limit-crossover-12000-01.json), [15,000](map-limit-crossover-15000-01.json), [18,000](map-limit-crossover-18000-01.json), [20,002](map-limit-crossover-20002-01.json)
- [Initial candidate versus prior pinned source](map-limit-candidate-parity-22596-01.json), [final 20,002 cutoff, six real-content conditions](map-limit-candidate-parity-22596-02.json)
- [Initial focused regression output](map-row-limit-tests.txt), [final cutoff regression output: 14 passed](map-row-limit-tests-final.txt)

No production deployment or upstream request was performed.
