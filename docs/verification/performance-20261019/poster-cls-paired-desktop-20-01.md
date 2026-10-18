# Saved-poster layout stability: pin11 → pin14

The two previously attributed large body/footer shifts did not recur in any of 20 candidate samples. Small movement in the result controls remains. This supports the layout fix; it does not establish a speed improvement or zero layout shift.

This compares the previously validated `candidate-wave11-selection` with `candidate-wave14-popup-reopen`, **not the initial session baseline**. The candidate includes popup changes as well as the two layout fixes. Both source and build fingerprints remained exact before/after. Raw evidence is [poster-cls-paired-desktop-20-01.json](poster-cls-paired-desktop-20-01.json); the derived checks are [summary JSON](poster-cls-paired-desktop-20-01-summary.json).

## Protocol and integrity

- 2026-10-18 18:09:16–18:10:14 UTC; 20 sequential AB/BA pairs, two excluded warmups per variant, fresh browser contexts, 1440×1000 desktop, no CPU throttle.
- The original poster-replay harness and saved corpus were reused. No additional external HTTP acquisition occurred.
- All 40 measured and four warmup samples completed: four exact saved GIFs (750×1000 each), rendered total 5,649, 30 cards, no runtime/unexpected-network errors, no pending routes or requests after cleanup.
- All 80 measured bootstrap/search responses were successful true producer misses (one read/one produce/zero joins each). Browser and both fixtures closed successfully.
- The four saved GIFs total 1,098,053 bytes. Each replay verifies SHA-256, raster signature, byte length and decoded dimensions. Other known posters use SVG placeholders; this is only a claim about the four visible real posters.
- [Ambient evidence](host-poster-cls-20-01.json): CPU mean 49.82%, maximum 53.74%; minimum free RAM 2,362 MiB. No user processes were terminated.

## Observations

| Metric | Pin11 | Pin14 |
| --- | ---: | ---: |
| No-input shift sum, minimum / median / maximum | 0.172037 / 0.172037 / 0.172037 | 0.002794 / 0.002794 / 0.002794 |
| Samples containing an individual shift ≥0.01 | 20/20 | 0/20 |
| Known large shift values, 0.0972222 and 0.0735431 | Each 20 times | Each 0 times |
| DOM-ready p50 / p95, ms | 484.1 / 563.9 | 484.9 / 625.4 |
| Visual-ready p50 / p95, ms | 731.8 / 947.2 | 749.1 / 959.6 |

The observed no-input shift sum fell 98.38%. Pin14 still records two small control shifts, 0.00127218 and 0.00152225, in every sample. These sums stop at visual readiness and are **not full-session Core Web Vitals CLS scores**.

The repeated harness stores shift values/times without source nodes. The separate source-attribution diagnostics establish that the old large values came from the body margin collapse and the initially visible source footer moving below results. [Diagnostic 02](poster-shift-diagnostic-02.json) observed body at y=0 throughout loading, the loader text at the exact original position, and the footer absent while results were pending. Its remaining source nodes were result controls. Thus this repeat study verifies absence of the previously observed large signatures, rather than claiming per-sample node attribution.

DOM median rose 0.17%; visual median rose 2.36%. Visual-ready medians across the three pair-index blocks were 715.1→749.1, 731.8→718.1 and 741.8→804.5 ms. The direction is mixed, and candidate visual readiness was faster in 10/20 pairs. No speed improvement or strict latency non-regression is claimed. The 20-sample p95 is descriptive; all outliers remain in the raw data.

Visual readiness means the visible rasters decoded and image/card rectangles stabilized. GIF animation is not frozen, and saved bytes are served locally, so this does not measure Internet poster delivery or animation completion. The final [candidate screenshot](poster-cls-paired-desktop-20-01-candidate.png) was visually inspected: four real posters fit their cards, text remains readable, and controls are unclipped.

## Reproduction

```sh
node --import tsx scripts/performance/poster-replay.ts --root data/performance-session-20261019/candidate-wave11-selection --compare-root data/performance-session-20261019/candidate-wave14-popup-reopen --manifest data/performance-session-20261019/posters-01/manifest.json --samples 20 --warmup 2 --device desktop --cpu-rate 1 --scroll none --ambient-evidence docs/verification/performance-20261019/host-poster-cls-20-01.json --out docs/verification/performance-20261019/poster-cls-paired-desktop-20-01.json
```

Use a new output path for a new experiment. The original baseline→pin11 20-pair report remains unchanged.
