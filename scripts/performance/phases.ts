import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { argumentsOf, coreRoutes, saveJson, semanticHash, snapshotInfo, statistics, workspace } from './common.js';

const args = argumentsOf(), root = resolve(args.root ?? workspace);
if (!args.out) throw new Error('--out is required');
const samples = Number(args.samples ?? '5');
const info = await snapshotInfo(root);
globalThis.fetch = async () => { throw new Error('Performance attribution forbids outbound fetch'); };
const [{ Store }, { createApp }, { NATIONAL_CITIES }, { insertPublicSnapshot }] = await Promise.all([
  import(pathToFileURL(resolve(root, 'server/store.ts')).href),
  import(pathToFileURL(resolve(root, 'server/app.ts')).href),
  import(pathToFileURL(resolve(root, 'server/providers/cities.ts')).href),
  import(pathToFileURL(resolve(root, 'server/cloud/readonly-fallback.ts')).href),
]);
let events: { phase: string; durationMs: number; rows?: number; bytes?: number }[] = [];
const performanceTrace = (event: typeof events[number]) => events.push(event);
const storeStart = performance.now();
const store = new Store(':memory:', NATIONAL_CITIES, { performanceTrace });
const storeSetupMs = performance.now() - storeStart;
const insertStart = performance.now();
insertPublicSnapshot(store, info.snapshot);
store.db.exec('PRAGMA query_only=ON');
const insertSnapshotMs = performance.now() - insertStart;
const { app } = await createApp({ port: 4317, databasePath: ':memory:', keys: { kopis: '', culture: '' }, requestIntervalMs: 350, syncIntervalHours: 24 },
  { store, providers: {}, startWorker: false, serveStatic: false, searchOnly: true, performanceTrace, readonlySnapshotAt: info.snapshot.snapshotAt });
await app.ready();
const raw: any[] = [];
try {
  for (const route of coreRoutes(info.snapshot).filter(row => ['national-search', 'national-map', 'regional-map'].includes(row.name))) {
    for (let index = -2; index < samples; index++) {
      events = [];
      const start = performance.now();
      const response = await app.inject({ method: 'GET', url: route.route, headers: { host: 'localhost:4317' } });
      const elapsedMs = performance.now() - start;
      if (response.statusCode !== 200) throw new Error(`HTTP ${response.statusCode}`);
      if (index >= 0) raw.push({ name: route.name, index, route: route.route, elapsedMs, bytes: response.rawPayload.byteLength,
        semanticHash: semanticHash(response.json()), phases: events });
    }
  }
} finally { await app.close(); store.close(); }
const phaseNames = [...new Set(raw.flatMap(row => row.phases.map((phase: any) => phase.phase)))];
if (!phaseNames.length) throw new Error('This source tree has no phase instrumentation');
const results = [...new Set(raw.map(row => row.name))].map(name => ({ name,
  total: statistics(raw.filter(row => row.name === name).map(row => row.elapsedMs)),
  phases: phaseNames.map(phase => ({ phase, values: raw.filter(row => row.name === name).flatMap(row => row.phases.filter((event: any) => event.phase === phase).map((event: any) => event.durationMs)) }))
    .filter(phase => phase.values.length).map(phase => ({ phase: phase.phase, ...statistics(phase.values) })),
}));
await saveJson(args.out, { version: 1, measuredAt: new Date().toISOString(), root, scope: 'Sequential instrumented Fastify router, without cloud envelope or response cache. Per-marker trace clocks add overhead; use attribution, not acceptance timings.',
  snapshot: { hash: info.hash, performances: info.count, bytes: info.bytes }, storeSetupMs, insertSnapshotMs, results, raw });
console.log(JSON.stringify({ out: args.out, storeSetupMs, insertSnapshotMs, results }, null, 2));
