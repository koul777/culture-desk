import { readFile } from 'node:fs/promises';
const report = JSON.parse(await readFile(process.argv[2], 'utf8'));
const cache = { reads: 0, produces: 0, joined: 0, requests: 0, anomalies: [] };
for (const row of report.raw) for (const response of row.network) {
  if (!response.url.startsWith('/api/') || !response.cache) continue;
  const value = JSON.parse(response.cache); cache.requests++;
  cache.reads += value.reads; cache.produces += value.produces; cache.joined += value.joined;
  if (value.reads !== value.produces + value.joined) cache.anomalies.push({ variant: row.variant, scenario: row.scenario, index: row.index, response });
}
const summarize = rows => rows.map(row => ({ variant: row.variant, scenario: row.scenario, n: row.samples, p50: row.p50Ms, p95: row.p95Ms }));
console.log(JSON.stringify({ sourceStable: report.source.map(source => ({ variant: source.variant, source: source.stable, build: source.build.stable })),
  cases: report.raw.length, cache, searchTotals: [...new Set(report.raw.map(row => row.searchTotal))],
  mapTotals: [...new Set(report.raw.filter(row => row.mapTotal !== undefined).map(row => row.mapTotal))],
  runtimeErrors: report.raw.flatMap(row => row.errors).length, maxOverflow: Math.max(...report.raw.map(row => row.overflow)),
  summary: summarize(report.summary), blocks: report.timeBlocks.map(block => ({ block: block.block, summary: summarize(block.summary) })) }, null, 2));
