import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { argumentsOf, coreRoutes, saveJson, sha256, semanticHash, snapshotInfo, sourceFingerprint, statistics, workspace } from './common.js';

const args = argumentsOf();
const root = resolve(args.root ?? workspace);
if (!args.out) throw new Error('--out is required');
const samples = Number(args.samples ?? '30'), warmup = Number(args.warmup ?? '5');
if (![samples, warmup].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1000) || samples < 1) throw new Error('Invalid sample counts');
const modes = (args.modes ?? 'miss,hit').split(',');
if (modes.some(mode => !['hit', 'miss'].includes(mode))) throw new Error('Only hit/miss modes are supported');
const info = await snapshotInfo(root);
const sourceBefore = await sourceFingerprint(root, ['server', 'shared']);
const { PublishedResponseCache } = await import(pathToFileURL(resolve(root, 'server/cloud/published-response-cache.ts')).href);
const original = PublishedResponseCache.prototype.read;
let activeMode = 'hit';
let observed = { read: 0, produce: 0, clearedEntries: 0, pendingBefore: 0 };
PublishedResponseCache.prototype.read = async function (key: string, day: string, produce: () => Promise<Response>) {
  const state = this as any;
  if (!(state.values instanceof Map) || !(state.pending instanceof Map) || typeof state.bytes !== 'number') throw new Error('Cache harness contract changed');
  observed.read++;
  observed.pendingBefore += state.pending.size;
  if (activeMode === 'miss') {
    if (state.pending.size) throw new Error('Miss measurement must be sequential without in-flight responses');
    observed.clearedEntries += state.values.size;
    state.values.clear(); state.bytes = 0;
  }
  return original.call(this, key, day, async () => { observed.produce++; return produce(); });
};
globalThis.fetch = async () => { throw new Error('Performance harness forbids outbound fetch'); };
const { handleCloudRequest } = await import(pathToFileURL(resolve(root, 'server/cloud/handler.ts')).href);
const options = { env: {}, readonlyFallback: { load: async () => info.snapshot } };
const selected = args.routes?.split(',');
const routes = coreRoutes(info.snapshot).filter(route => !selected || selected.includes(route.name));
if (!routes.length) throw new Error('No selected routes');
const raw: any[] = [], results: any[] = [];
async function read(route: string, mode: string, index: number) {
  activeMode = mode;
  observed = { read: 0, produce: 0, clearedEntries: 0, pendingBefore: 0 };
  const start = performance.now();
  const response = await handleCloudRequest(new Request(`http://performance.test${route}`), options);
  const bytes = Buffer.from(await response.arrayBuffer());
  const elapsedMs = performance.now() - start;
  if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${route}`);
  if (observed.read !== 1 || observed.pendingBefore !== 0 || observed.produce !== (mode === 'miss' ? 1 : 0)) throw new Error(`Unexpected cache state ${mode}: ${JSON.stringify(observed)}`);
  const payload = JSON.parse(bytes.toString('utf8'));
  return { index, mode, route, elapsedMs, bytes: bytes.byteLength, cache: { ...observed }, wireHash: sha256(bytes), semanticHash: semanticHash(payload),
    metadata: { snapshotAt: payload.snapshotAt, published: payload.published, total: payload.total, truncated: payload.truncated },
    headers: Object.fromEntries(response.headers), status: response.status, memory: process.memoryUsage() };
}
for (const route of routes) {
  // Prepare the model, router, and one response outside both measured distributions.
  await read(route.route, 'miss', -1);
  for (const mode of modes) {
    for (let i = 0; i < warmup; i++) await read(route.route, mode, -1);
    // With zero warmup a preceding miss already leaves the exact response cached.
    const rows = [];
    for (let i = 0; i < samples; i++) { const row = await read(route.route, mode, i); rows.push(row); raw.push({ name: route.name, ...row }); }
    if (new Set(rows.map(row => row.semanticHash)).size !== 1) throw new Error(`Unstable ${route.name}/${mode}`);
    results.push({ name: route.name, route: route.route, mode, ...statistics(rows.map(row => row.elapsedMs)), bytes: rows[0].bytes, semanticHash: rows[0].semanticHash });
  }
}
PublishedResponseCache.prototype.read = original;
const sourceAfter = await sourceFingerprint(root, ['server', 'shared']);
const report = { version: 1, measuredAt: new Date().toISOString(), root, variant: args.variant ?? root, node: process.version, platform: process.platform,
  scope: 'Prepared snapshot/model/router. Timed handler + response bytes. Miss clears only completed response cache entries, not model/router/day. Cache state asserted per operation. Canonical JSON preserves every field including snapshotAt.',
  snapshot: { hash: info.hash, bytes: info.bytes, performances: info.count },
  source: { before: sourceBefore, afterHash: sourceAfter.hash, stable: sourceBefore.hash === sourceAfter.hash }, warmup, samples, results, raw };
await saveJson(args.out, report);
if (!report.source.stable) throw new Error('Source changed during API measurements; report is not an acceptance run');
console.log(JSON.stringify({ out: args.out, results }, null, 2));
