import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { argumentsOf, saveJson, sha256, snapshotInfo, sourceFingerprint, statistics, workspace } from './common.js';

// Offline stability workload, not an isolated latency benchmark. Point --root at a
// pinned candidate copy so implementation work cannot change the observed version.
const args = argumentsOf(), root = resolve(args.root ?? workspace);
if (!args.out) throw new Error('--out is required');
const minutes = Number(args.minutes ?? '60'), intervalMs = Number(args.interval ?? '2000');
if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 120 || !Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 10000) throw new Error('Invalid duration/interval');
const maxWallMs = Number(args['max-wall-minutes'] ?? String(minutes + 30)) * 60_000;
if (!Number.isFinite(maxWallMs) || maxWallMs < minutes * 60_000 || maxWallMs > 180 * 60_000) throw new Error('Invalid wall limit');
const output = resolve(args.out), samplesFile = output.replace(/\.json$/, '') + '.ndjson';
const control = args.control ? resolve(args.control) : undefined;
await mkdir(dirname(output), { recursive: true });
await writeFile(samplesFile, '');
const info = await snapshotInfo(root), sourceBefore = await sourceFingerprint(root, ['server', 'shared']);
const { PublishedResponseCache } = await import(pathToFileURL(resolve(root, 'server/cloud/published-response-cache.ts')).href);
const original = PublishedResponseCache.prototype.read;
const caches = new Set<any>();
const counts = { requests: 0, successful: 0, expectedErrors: 0, reads: 0, hits: 0, joins: 0, produces: 0,
  evictionObservations: 0, maxEntriesObserved: 0, maxBytesObserved: 0, hashHistoryEvictions: 0 };
const context = new AsyncLocalStorage<{ produces: number }>();
PublishedResponseCache.prototype.read = async function (key: string, day: string, produce: () => Promise<Response>) {
  const state = this as any;
  assert.ok(state.values instanceof Map && state.pending instanceof Map, 'Cache instrumentation contract');
  caches.add(state); counts.reads++;
  if (state.day === day && state.values.has(key)) counts.hits++;
  else if (state.day === day && state.pending.has(key)) counts.joins++;
  const request = context.getStore();
  const before = [...state.values.keys()];
  const response = await original.call(this, key, day, async () => { counts.produces++; if (request) request.produces++; return produce(); });
  counts.evictionObservations += before.filter(name => !state.values.has(name)).length;
  return response;
};
globalThis.fetch = async () => { throw new Error('Soak workload forbids outbound fetch'); };
const { handleCloudRequest } = await import(pathToFileURL(resolve(root, 'server/cloud/handler.ts')).href);
const { loadReadonlyFallback } = await import(pathToFileURL(resolve(root, 'server/cloud/readonly-fallback.ts')).href);
const options = { env: {}, readonlyFallback: { artifactPath: info.path } };
const model = await loadReadonlyFallback(options.readonlyFallback);
assert.ok(model, 'Valid snapshot model');
const databaseHash = () => sha256(JSON.stringify(model.store.db.prepare('SELECT * FROM performances ORDER BY id').all()));
const dataBefore = databaseHash();
const cities: string[] = [...new Set<string>(info.snapshot.performances.map((item: any) => item.cityId))];
const genres: string[] = [...new Set<string>(info.snapshot.performances.map((item: any) => item.genre).filter(Boolean))];
const queryHashes = new Map<string, string>();
const baseQuery = new URLSearchParams({ from: info.snapshot.coverage.from, to: info.snapshot.coverage.to });
const pinnedHashes = new Set(['GET /api/bootstrap', `GET /api/map?${baseQuery}`, `GET /api/performances?${baseQuery}`]);
let hashPayloadBytes = 0;
const histogram = monitorEventLoopDelay({ resolution: 20 });
const raw: any[] = [], latencies: number[] = [];
const startedAt = new Date().toISOString(), started = performance.now();
let activeMs = 0, pausedMs = 0, cycles = 0, lastSample = started, previousState = 'starting', failure: string | undefined;
let sequence = 0x19c0ffee;
function random(max: number): number { sequence ^= sequence << 13; sequence ^= sequence >>> 17; sequence ^= sequence << 5; return (sequence >>> 0) % max; }
function budgets() {
  return [...caches].map(state => {
    const bytes = [...state.values.values()].reduce((sum: number, value: any) => sum + value.size, 0);
    assert.equal(state.bytes, bytes, 'Accounted cache bytes equal retained response bytes');
    assert.ok(bytes <= 16 * 1024 * 1024 && state.values.size <= 32, 'Default response cache bounds');
    counts.maxEntriesObserved = Math.max(counts.maxEntriesObserved, state.values.size);
    counts.maxBytesObserved = Math.max(counts.maxBytesObserved, bytes);
    return { entries: state.values.size, retainedBytes: bytes, pending: state.pending.size };
  });
}
async function request(path: string, method = 'GET', expected = 200) {
  const begin = performance.now();
  const response = await context.run({ produces: 0 }, () => handleCloudRequest(new Request(`http://soak.test${path}`, { method }), options));
  const body = Buffer.from(await response.arrayBuffer());
  latencies.push(performance.now() - begin);
  counts.requests++;
  assert.equal(response.status, expected, `${method} ${path}`);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  if (method === 'HEAD') { assert.equal(body.length, 0); counts.successful++; return undefined; }
  const payload = JSON.parse(body.toString('utf8'));
  if (expected !== 200) { assert.equal(typeof payload.error, 'string'); counts.expectedErrors++; return payload; }
  counts.successful++;
  assert.equal(response.headers.get('x-culture-data-mode'), 'published');
  assert.equal(response.headers.get('x-culture-snapshot-at'), info.snapshot.snapshotAt);
  if (Array.isArray(payload.items)) {
    assert.equal(payload.snapshotAt, info.snapshot.snapshotAt);
    assert.equal(payload.sourceCounts.kopis + payload.sourceCounts.culture, payload.total);
    assert.equal(new Set(payload.items.map((item: any) => item.id)).size, payload.items.length);
    assert.ok(payload.pendingDetails >= 0 && payload.items.length <= payload.total);
    if (path.startsWith('/api/map?')) {
      assert.ok(body.length <= 3 * 1024 * 1024 && payload.items.length <= 10000);
      assert.equal(payload.truncated, payload.items.length < payload.total);
      for (const item of payload.items) assert.ok(!('note' in item) && !('description' in item) && !('venueInfo' in item));
    } else for (const item of payload.items) { assert.equal(item.bookmarked, false); assert.equal(item.note, ''); }
  } else if (payload.published) assert.equal(payload.published.snapshotAt, info.snapshot.snapshotAt);
  else { assert.equal(payload.bookmarked, false); assert.equal(payload.note, ''); }
  const key = `${method} ${path}`, hash = sha256(body), prior = queryHashes.get(key);
  if (prior) assert.equal(hash, prior, `Immutable response changed: ${key}`);
  else {
    while (queryHashes.size >= 4096) {
      const oldest = queryHashes.keys().next().value!;
      const value = queryHashes.get(oldest)!; queryHashes.delete(oldest);
      if (pinnedHashes.has(oldest)) { queryHashes.set(oldest, value); continue; }
      hashPayloadBytes -= Buffer.byteLength(oldest) + value.length;
      counts.hashHistoryEvictions++;
    }
    queryHashes.set(key, hash); hashPayloadBytes += Buffer.byteLength(key) + hash.length;
  }
  return payload;
}
async function sample(state: string) {
  const entry = { at: new Date().toISOString(), state, wallMs: performance.now() - started, activeMs, pausedMs, cycles,
    counts: { ...counts }, hashHistory: { retainedQueries: queryHashes.size, keyAndHashUtf8Bytes: hashPayloadBytes, excludesObjectOverhead: true }, memory: process.memoryUsage(), caches: budgets(),
    eventLoop: { p50Ms: histogram.percentile(50) / 1e6, p95Ms: histogram.percentile(95) / 1e6, maxMs: histogram.max / 1e6 },
    recentLatency: latencies.length ? statistics(latencies.splice(0)) : undefined };
  raw.push(entry); histogram.reset(); lastSample = performance.now();
  await appendFile(samplesFile, JSON.stringify(entry) + '\n');
  console.log(JSON.stringify(entry));
}
histogram.enable();
try {
  await request('/api/bootstrap');
  while (activeMs < minutes * 60_000 && performance.now() - started < maxWallMs) {
    let paused = false;
    if (control) {
      try { paused = JSON.parse((await readFile(control, 'utf8')).replace(/^\uFEFF/, '')).paused === true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const state = paused ? 'paused' : 'running';
    if (state !== previousState || performance.now() - lastSample >= 60_000) { previousState = state; await sample(state); }
    const tick = performance.now();
    if (paused) { await delay(500); pausedMs += performance.now() - tick; continue; }
    const params = new URLSearchParams({ from: info.snapshot.coverage.from, to: info.snapshot.coverage.to });
    if (cycles % 6 !== 0) params.set('cities', cities[random(cities.length)]);
    if (cycles % 4 === 0) params.set('source', random(2) ? 'kopis' : 'culture');
    if (cycles % 5 === 0) params.set('genre', genres[random(genres.length)]);
    if (cycles % 7 === 0) params.set('price', ['free', 'paid', 'unknown'][random(3)]);
    const map = `/api/map?${params}`, search = `/api/performances?${params}`;
    const item = info.snapshot.performances[random(info.count)];
    const detail = `/api/performances/${item.id}`;
    const settled = await Promise.allSettled([request(map), request(map), request(search), request(search), request(detail),
      request(detail, 'HEAD'), request('/api/performances?from=invalid', 'GET', 400), request('/api/bootstrap')]);
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
    const results = settled.map(result => (result as PromiseFulfilledResult<any>).value);
    assert.equal(results[0].total, results[2].total, 'Map/list totals under identical filters');
    assert.ok(budgets().every(cache => cache.pending === 0), 'All in-flight cache work released');
    assert.equal(model.store.db.prepare('PRAGMA query_only').get()!.query_only, 1);
    cycles++;
    await delay(Math.max(0, intervalMs - (performance.now() - tick)));
    activeMs += performance.now() - tick;
  }
  assert.ok(activeMs >= minutes * 60_000, 'Wall limit reached before required active soak duration');
  assert.ok(counts.hits > 0 && counts.joins > 0 && counts.produces > 0, 'Workload exercised hits, coalescing and misses');
  if (minutes >= 1) assert.ok(counts.maxEntriesObserved === 32 || counts.evictionObservations > 0, 'Workload exercised cache pressure');
  assert.equal(databaseHash(), dataBefore, 'Read-only workload did not mutate persisted rows');
  await sample('complete');
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  await sample('failed');
} finally {
  histogram.disable(); PublishedResponseCache.prototype.read = original;
  const sourceAfter = await sourceFingerprint(root, ['server', 'shared']);
  if (sourceBefore.hash !== sourceAfter.hash) failure ??= 'Source changed during soak; use pinned source';
  await saveJson(output, { version: 1, startedAt, endedAt: new Date().toISOString(), root,
    scope: 'Offline real-data mixed GET/HEAD, same/different-key bursts, expected invalid-input errors. Natural GC. Stability workload; latency is diagnostic, not an isolated before/after benchmark. Active duration excludes explicit pauses.',
    requestedMinutes: minutes, intervalMs, activeMs, pausedMs, wallMs: performance.now() - started, cycles,
    success: !failure, failure, snapshot: { hash: info.hash, performances: info.count },
    source: { before: sourceBefore, afterHash: sourceAfter.hash }, counts,
    hashHistory: { retainedQueries: queryHashes.size, keyAndHashUtf8Bytes: hashPayloadBytes, excludesObjectOverhead: true }, raw });
  model.store.close();
}
if (failure) throw new Error(failure);
