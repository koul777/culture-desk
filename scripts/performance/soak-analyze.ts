import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { argumentsOf, saveJson, sha256 } from './common.js';

const args = argumentsOf();
assert.ok(args.input && args.out, '--input and --out are required');
const bytes = await readFile(args.input), report = JSON.parse(bytes.toString('utf8'));
assert.equal(report.success, true, 'Only completed successful soak reports can be summarized');
assert.ok(report.activeMs >= report.requestedMinutes * 60_000);
assert.equal(report.counts.requests, report.counts.successful + report.counts.expectedErrors);
assert.equal(report.counts.requests, report.cycles * 8 + 1);
assert.equal(report.source.before.hash, report.source.afterHash);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const burnInMinutes = 10, windowMinutes = 5, mib = 1024 * 1024;
// The final database integrity hash allocates a full JSON copy before "complete".
// Keep that verification-only allocation out of steady workload memory windows.
const samples = report.raw.filter((row: any) => row.state === 'running');
const groups = new Map<number, any[]>();
for (const row of samples) {
  if (row.activeMs < burnInMinutes * 60_000) continue;
  const index = Math.floor((row.activeMs / 60_000 - burnInMinutes) / windowMinutes);
  groups.set(index, [...(groups.get(index) ?? []), row]);
}
const windows = [...groups.entries()].map(([index, rows]) => ({
  index, activeStartMinute: burnInMinutes + index * windowMinutes, samples: rows.length,
  firstSampleActiveMinute: Math.min(...rows.map(row => row.activeMs)) / 60_000,
  lastSampleActiveMinute: Math.max(...rows.map(row => row.activeMs)) / 60_000,
  fullDurationElapsed: report.activeMs >= (burnInMinutes + (index + 1) * windowMinutes) * 60_000,
  heapLowerMiB: Math.min(...rows.map(row => row.memory.heapUsed)) / mib,
  rssLowerMiB: Math.min(...rows.map(row => row.memory.rss)) / mib,
  externalLowerMiB: Math.min(...rows.map(row => row.memory.external)) / mib,
}));
// Require the whole bin's active time and at least three observations. Neither
// condition guarantees a GC cycle; these are observed minima, not retained heap.
const fullWindows = windows.filter(row => row.fullDurationElapsed && row.samples >= 3);
const slopes: number[] = [];
for (let i = 0; i < fullWindows.length; i++) for (let j = i + 1; j < fullWindows.length; j++) {
  slopes.push((fullWindows[j].heapLowerMiB - fullWindows[i].heapLowerMiB)
    / (fullWindows[j].activeStartMinute - fullWindows[i].activeStartMinute));
}
const endpointCount = Math.min(3, Math.floor(fullWindows.length / 2));
const endpoints = endpointCount ? {
  windowsPerEndpoint: endpointCount,
  earlyLowerHeapMedianMiB: median(fullWindows.slice(0, endpointCount).map(row => row.heapLowerMiB)),
  lateLowerHeapMedianMiB: median(fullWindows.slice(-endpointCount).map(row => row.heapLowerMiB)),
} : undefined;
const summary = {
  analyzedAt: new Date().toISOString(), input: args.input, inputSha256: sha256(bytes),
  scope: 'Natural-GC memory observations from one bounded stability workload, not proof that every application path is leak-free. Explicit paused time and final integrity-hash allocations are excluded. No forced GC, request latency acceptance or baseline memory improvement claim.',
  startedAt: report.startedAt, endedAt: report.endedAt, requestedMinutes: report.requestedMinutes,
  activeMinutes: report.activeMs / 60_000, pausedMinutes: report.pausedMs / 60_000, wallMinutes: report.wallMs / 60_000,
  requests: report.counts.requests, successful: report.counts.successful, expectedErrors: report.counts.expectedErrors,
  counts: report.counts, snapshot: report.snapshot, sourceHash: report.source.before.hash,
  last: report.raw.at(-1),
  memory: { burnInMinutes, windowMinutes, windows, endpoints,
    theilSenHeapLowerSlopeMiBPerActiveMinute: slopes.length ? median(slopes) : null,
    endpointDeltaMiB: endpoints ? endpoints.lateLowerHeapMedianMiB - endpoints.earlyLowerHeapMedianMiB : null,
    interpretation: 'Inspect lower envelopes together with retained cache bytes, hash-history bounds and pauses. Positive slope alone is not a leak verdict; investigate sustained growth using a separate heap profile.' },
};
await saveJson(args.out, summary);
console.log(JSON.stringify({ out: args.out, activeMinutes: summary.activeMinutes, requests: summary.requests,
  memorySlope: summary.memory.theilSenHeapLowerSlopeMiBPerActiveMinute, endpointDeltaMiB: summary.memory.endpointDeltaMiB }));
