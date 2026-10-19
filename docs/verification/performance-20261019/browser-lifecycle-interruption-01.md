# Lifecycle observation interrupted — 60-minute target incomplete

The fixed wave18 run **did not complete 60 active minutes**. It completed 239 cycles and 976,054.427 ms (16.2676 minutes) of active work. An authorized pause of 220,941.907 ms (3 minutes 40.942 seconds) was excluded from active time. Cycle 240 started but did not complete. There is no final full-ID verification record or completed worker result JSON.

The last normal card-state sample is **2026-10-18 19:40:48.240 UTC**. The next recorded event is **2026-10-19 01:05:14.326 UTC**, a gap of 5 hours 24 minutes 26.086 seconds. That event records `/api/map` failing with **`net::ERR_NETWORK_IO_SUSPENDED`**, with one pending request and route. The supervisor reports its **5,520,000 ms external watchdog** expired and ended at 01:05:32.718 UTC. The artifacts establish interrupted execution/network continuity; they do not establish whether sleep, suspension, a clock change, or another host event caused it. The gap is not counted as active work.

Within the completed 239 cycles, 12 full popup ID/order scans passed. All 239 post-unmount samples had 2,040 live DOM elements and no map/popup/dialog; observed unmount intervals were at least 36 RAF callbacks and 600 ms. Across 336 recorded samples, maximum JS heap was 85.73 MiB; minimum post-unmount heap was 8.66 MiB. At the last normal boundary all 2,831 requests had completed, with no failed/unexpected external requests and no pending work. These are partial functional/resource observations, not a 60-minute stability or no-leak result.

Cleanup was **not wholly successful**: worker PID 54688 and fixture PID 38600 terminated, but Chromium PID 37208 close exceeded five seconds and its owned-tree `taskkill` reported failure. The supervisor's final `survivingOwnedPids` array was empty. A separate read-only `Get-Process` check at **2026-10-19 01:59:10.940 UTC** found none of those three owned PIDs present. This does not erase the cleanup errors or prove the status of every possible descendant. No user process was terminated.

Source, client, harness, snapshot, and manifest hashes matched before and after. Product and harness files remain frozen. Root independently confirmed the current time was past the session deadline; no restart or further runtime was attempted.

Evidence:

- [Supervisor result and cleanup](browser-lifecycle-wave18-60min-01.json)
- [Partial supervisor report](browser-lifecycle-wave18-60min-01.json.partial.json)
- [Append-only samples and interruption](browser-lifecycle-wave18-60min-01.ndjson)
- [Pre-run host observations, 3 × 1 second](host-browser-lifecycle-wave18-60min-01.json)
- [Earlier successful three-cycle smoke assessment](browser-lifecycle-smoke-assessment.md)

The unfinished 60-minute lifecycle check requires a separately scheduled uninterrupted runtime window. The passing three-cycle smoke remains separate evidence; this interrupted run must not be described as its successful 60-minute extension.
