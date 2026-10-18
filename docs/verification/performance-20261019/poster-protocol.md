# Bounded poster replay supplement

The main browser comparison's card endpoint waits for card DOM, a nonbusy results region and two stable animation frames. It does not await image decode. Its local SVG substitutes therefore cannot establish real poster decoding or visual readiness.

The supplemental corpus selects at most eight unique poster URLs from images that intersect the initial cards viewport. URLs must occur in the same published snapshot. Selection itself uses local placeholders; it does not download every lazy image requested by the browser. The acquisition phase makes one bounded fetch per selected URL, follows normal redirects, permits no retry or crawl, and limits each body to 5 MiB and the HTTP operation to 30 seconds. Original URL, final URL, status, content type, byte count, SHA-256, decoded dimensions and errors are preserved. Failed sources remain visible in the manifest and are not silently replaced with another poster.

Replay serves exactly the stored bytes to baseline and candidate fresh contexts. It performs no upstream requests. Images outside the selected set retain the stated SVG substitute. Any initially visible image absent from the selected set is reported, and that viewport is not accepted as complete visual coverage. This is a bounded local raster workload, not a reproduction of poster CDN latency or Internet throughput.

Corpus version 2 requires a supported PNG, JPEG, GIF, WebP or AVIF file signature matching its MIME type, then a successful browser decode. SVG and unknown or mismatched signatures are rejected. The manifest records the actual format and signature prefix. Replay rechecks file hash, byte count, signature and decoded dimensions; every visible raster must have a recorded successful route fulfillment with that exact URL and SHA-256. Bootstrap/search response headers must show actual producer misses, not an assumed fixture cache mode.

Both DOM-frame and image/card-rectangle stability waits have independent five-second deadlines that do not depend on another animation frame arriving. Every partial save retains snapshot, source and client-build provenance. Raw samples are saved before context/browser/process cleanup, then augmented with bounded cleanup results. Route promises must settle; request terminal events are recorded separately from requests cancelled by a confirmed context close without a terminal event. Browser cleanup can terminate only the owned process ID obtained from Playwright's `launchServer`, never unrelated browser processes. A cleanup failure invalidates the run and leaves its partial evidence available.

A report-write failure is captured in `persistenceErrors` and stderr, invalidates the run and does not prevent subsequent context, browser or fixture cleanup. Later saves retain that error if storage recovers. The measured supplement records an ambient-evidence path/hash and three contiguous pair-index blocks, retaining warmups separately. The smaller block quantiles diagnose drift; they do not establish independent tail-latency claims.

Keep the existing DOM-ready comparison unchanged. Record these supplemental observations separately:

- DOM readiness from navigation, using the same common result/card observables.
- Initial viewport image URL set, resource transfer timing and decoded dimensions.
- Completion of `HTMLImageElement.decode()` for every initially visible saved image, followed by two consecutive animation frames with unchanged image/card rectangles.
- Visual readiness from navigation and additional wait after DOM readiness.
- Layout shift entries before visual readiness, excluding recent user input, and horizontal overflow.
- Runtime/network errors and source, client-build, snapshot and image-byte fingerprints.

The additional wait after DOM readiness is not an isolated decoder CPU measurement: image fetch and decoding may already have progressed before the DOM endpoint. Resource timing, decode completion and visual readiness answer different questions and must remain separate. A successful decode also does not establish image quality or relevance; that requires visual inspection of the captured viewport.

The stability condition concerns image/card rectangles, not changing pixels inside animated GIF, WebP or AVIF content. It does not wait for an animation to finish or claim identical animation frames across screenshots.

Start with a small functional pair to confirm exact replay and complete initial-viewport coverage. Only then run a modest AB/BA comparison if the image supplement adds useful information. Do not repeat the full 40-pair DOM matrix merely to add screenshots or a new endpoint.

At 375 × 812, the initial viewport ends at the results controls and may contain no poster. Zero visible images is an explicit failure for image-readiness coverage. Acquire the desktop initial-viewport corpus first. A mobile supplement must use the separately named `explicit-scroll-to-first-result` scenario (`--scroll first-result`), preserve the original viewport, and report scroll-start-to-visual-ready separately. It must not be labeled initial mobile image readiness.
