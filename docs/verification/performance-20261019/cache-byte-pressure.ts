import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { argumentsOf, semanticHash, sha256, snapshotInfo, sourceFingerprint } from '../../../scripts/performance/common.js';
import { runJsonChild } from '../../../scripts/performance/child-process.js';

// Finite functional integration check only. The production cache is unchanged.
const args = argumentsOf();
assert.ok(args.root && args.snapshot && args.out, '--root, --snapshot and --out are required');
const output = resolve(args.out), script = fileURLToPath(import.meta.url);
const harnessFingerprint = async () => {
  const paths = [script, fileURLToPath(new URL('../../../scripts/performance/common.ts', import.meta.url)),
    fileURLToPath(new URL('../../../scripts/performance/child-process.ts', import.meta.url)),
    fileURLToPath(new URL('../../../scripts/performance/child-lifecycle.ts', import.meta.url))];
  const files = Object.fromEntries(await Promise.all(paths.map(async path => [path, sha256(await readFile(path))])));
  return { hash: semanticHash(files), files };
};

async function run() {
  const root = resolve(args.root), sourceBefore = await sourceFingerprint(root, ['server', 'shared']);
  const harnessBefore = await harnessFingerprint(), info = await snapshotInfo(root, args.snapshot);
  assert.ok(info.bytes <= 64 * 1024 * 1024);
  assert.equal(info.count, 100000, 'Use the explicit minimal 100k synthetic fixture');
  assert.ok(info.snapshot.performances.every((row: any) => ['kopis', 'culture'].includes(row.source)));
  globalThis.fetch = async () => { throw new Error('Byte-pressure smoke forbids outbound fetch'); };
  const { PublishedResponseCache } = await import(pathToFileURL(resolve(root, 'server/cloud/published-response-cache.ts')).href);
  const { handleCloudRequest } = await import(pathToFileURL(resolve(root, 'server/cloud/handler.ts')).href);
  const { loadReadonlyFallback } = await import(pathToFileURL(resolve(root, 'server/cloud/readonly-fallback.ts')).href);
  const { buildMapResult } = await import(pathToFileURL(resolve(root, 'server/map-response.ts')).href);
  const options = { env: {}, readonlyFallback: { artifactPath: info.path } };
  const model = await loadReadonlyFallback(options.readonlyFallback);
  assert.ok(model, 'Actual artifact loader accepted the unchanged fixture');
  const originalRead = PublishedResponseCache.prototype.read;
  const states = new Set<any>(), responseObjects = new Set<Response>();
  const oracle = new Map<string, { hash: string; bytes: number; items: number; total: number; partial: boolean }>();
  const records: any[] = [], cacheObservations: any[] = [], bursts: any[] = [];
  const counts = { reads: 0, hits: 0, joins: 0, produces: 0, requests: 0, heads: 0, maxPending: 0, maxEntries: 0, maxBytes: 0 };
  const produceByKey = new Map<string, number>();
  const cap = 16 * 1024 * 1024, startedAt = new Date().toISOString();
  let failure: string | undefined, dataBefore: any, dataAfter: any, firstPressure: any;
  function databaseHash() {
    assert.equal(model.store.db.prepare('PRAGMA query_only').get().query_only, 1);
    const schema = model.store.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
    const digest = createHash('sha256').update(JSON.stringify(schema));
    const tables: Record<string, number> = {};
    for (const entry of schema.filter((row: any) => row.type === 'table')) {
      digest.update(`\nTABLE:${entry.name}\n`); let rows = 0;
      const name = String(entry.name).replaceAll('"', '""');
      for (const row of model.store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).iterate()) {
        digest.update(JSON.stringify(row)).update('\n'); rows++;
      }
      tables[entry.name] = rows;
    }
    return { hash: digest.digest('hex'), tables, changes: model.store.db.prepare('SELECT total_changes() AS n').get().n };
  }
  function observe(phase: string, drained = false) {
    for (const state of states) {
      let bytes = 0;
      for (const [key, value] of state.values) {
        assert.equal(value.size, value.bytes.byteLength, 'Each accounted entry equals its actual byte buffer');
        assert.equal(sha256(value.bytes), oracle.get(key)!.hash, 'Retained cache body equals the independent wire oracle');
        bytes += value.size;
      }
      assert.equal(state.bytes, bytes, 'Cache byte accounting equals all retained response buffers');
      assert.ok(bytes <= cap && state.values.size <= 32, 'Default production limits');
      if (drained) assert.equal(state.pending.size, 0, 'No pending producer remains after a burst');
      counts.maxPending = Math.max(counts.maxPending, state.pending.size);
      counts.maxEntries = Math.max(counts.maxEntries, state.values.size);
      counts.maxBytes = Math.max(counts.maxBytes, bytes);
      cacheObservations.push({ phase, day: state.day, bytes, entries: state.values.size, pending: state.pending.size, keys: [...state.values.keys()] });
    }
  }
  PublishedResponseCache.prototype.read = async function (key: string, day: string, produce: () => Promise<Response>) {
    const state = this as any;
    assert.ok(state.values instanceof Map && state.pending instanceof Map, 'Pinned instrumentation contract');
    states.add(state); counts.reads++;
    if (state.day === day && state.values.has(key)) counts.hits++;
    else if (state.day === day && state.pending.has(key)) counts.joins++;
    const pending = originalRead.call(this, key, day, async () => {
      counts.produces++; produceByKey.set(key, (produceByKey.get(key) ?? 0) + 1); return produce();
    });
    observe('read-start');
    try { return await pending; }
    finally { observe('read-complete'); }
  };
  try {
    dataBefore = databaseHash();
    const ordered = [...info.snapshot.performances].sort((a: any, b: any) => b.startDate.localeCompare(a.startDate) || b.id - a.id);
    const keys: string[] = [];
    for (let offset = 0; offset < 6; offset++) for (const source of ['kopis', 'culture']) {
      const date = new Date(`${info.snapshot.coverage.from}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() - offset);
      const filters = { from: date.toISOString().slice(0, 10), to: info.snapshot.coverage.to, source };
      const key = `/api/map?${new URLSearchParams(filters)}`;
      // Independent of compact map SQL, map row limiting, HTTP and response cache:
      // select/order original artifact rows, and use ordinary paged-search metadata.
      const selected = ordered.filter((row: any) => row.source === source && row.endDate >= filters.from && row.startDate <= filters.to);
      const metadata = model.store.search(filters);
      assert.equal(selected.length, metadata.total);
      const value = buildMapResult({ ...metadata, items: selected, snapshotAt: info.snapshot.snapshotAt });
      const bytes = Buffer.from(JSON.stringify(value));
      assert.equal(value.items.length, 10000); assert.equal(value.truncated, true);
      assert.ok(bytes.length > 2 * 1024 * 1024 && bytes.length <= 3 * 1024 * 1024);
      oracle.set(key, { hash: sha256(bytes), bytes: bytes.length, items: value.items.length, total: value.total, partial: value.partial });
      keys.push(key);
    }
    assert.equal(states.size, 0, 'Oracle never enters the response cache');
    async function request(key: string, method = 'GET') {
      const started = performance.now();
      const response = await handleCloudRequest(new Request(`https://pressure.test${key}`, { method }), options);
      assert.ok(!responseObjects.has(response), 'Each request owns a distinct Response object'); responseObjects.add(response);
      const body = new Uint8Array(await response.arrayBuffer()); counts.requests++;
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
      assert.equal(response.headers.get('x-culture-data-mode'), 'published');
      assert.equal(response.headers.get('x-culture-snapshot-at'), info.snapshot.snapshotAt);
      assert.ok(response.headers.get('content-type')?.startsWith('application/json'));
      const expected = oracle.get(key)!;
      if (method === 'HEAD') { assert.equal(body.length, 0); counts.heads++; }
      else { assert.equal(body.byteLength, expected.bytes); assert.equal(sha256(body), expected.hash, 'Complete HTTP wire bytes equal the uncached artifact oracle'); }
      records.push({ key, method, status: response.status, bytes: body.byteLength, hash: sha256(body), elapsedMs: performance.now() - started });
      observe('body-complete');
    }
    async function burst(name: string, calls: { key: string; method?: string }[]) {
      assert.equal(calls.length, 8);
      const before = { ...counts };
      const settled = await Promise.allSettled(calls.map(({ key, method }) => request(key, method)));
      const rejected = settled.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
      if (rejected) throw rejected.reason;
      observe(`burst-${name}`, true);
      assert.equal(model.store.db.prepare('PRAGMA query_only').get().query_only, 1);
      bursts.push({ name, calls, before, after: { ...counts } });
    }
    await burst('eight-distinct-large-misses', keys.slice(0, 8).map(key => ({ key })));
    assert.equal(states.size, 1, 'One immutable snapshot owns one response cache');
    const state = [...states][0], firstBytes = keys.slice(0, 8).reduce((sum, key) => sum + oracle.get(key)!.bytes, 0);
    assert.ok(firstBytes > cap, 'Eight response bodies exceed the default byte budget');
    assert.ok(state.values.size < 8 && state.values.size < 32, 'Byte eviction occurred before the entry limit');
    const evicted = keys.slice(0, 8).filter(key => !state.values.has(key));
    assert.ok(evicted.length > 0); assert.equal(counts.produces, 8); assert.equal(counts.reads, 8);
    firstPressure = { attemptedBytes: firstBytes, cap, retainedBytes: state.bytes, retainedEntries: state.values.size, evicted };
    const cold = evicted[0], hot = [...state.values.keys()].at(-1) as string, oldProduces = produceByKey.get(cold)!;
    await burst('cold-join-head-hot-and-new-keys', [{ key: cold }, { key: cold }, { key: cold, method: 'HEAD' }, { key: hot }, ...keys.slice(8).map(key => ({ key }))]);
    assert.equal(produceByKey.get(cold), oldProduces + 1, 'Two cold GET readers share one producer; HEAD bypasses the cache');
    const nextCold = keys.find(key => !state.values.has(key))!;
    assert.ok(nextCold);
    const nextHot = [...state.values.keys()].at(-1) as string;
    await burst('eviction-retry-and-hit-bodies', [{ key: nextCold }, { key: nextCold }, { key: nextCold, method: 'HEAD' },
      { key: nextHot }, { key: nextHot }, { key: nextHot, method: 'HEAD' }, { key: keys[10] }, { key: keys[11] }]);
    assert.equal(counts.requests, 24); assert.equal(counts.heads, 3); assert.equal(counts.reads, 21, 'HEAD never enters the GET response cache');
    assert.ok(counts.hits > 0 && counts.joins >= 2 && counts.maxPending >= 8);
    assert.equal(new Set(cacheObservations.map(row => row.day)).size, 1, 'No day invalidation confounds byte eviction');
    dataAfter = databaseHash(); assert.deepEqual(dataAfter, dataBefore, 'All persisted tables/schema and total changes remain identical');
  } catch (error) { failure = error instanceof Error ? error.stack ?? error.message : String(error); }
  finally {
    PublishedResponseCache.prototype.read = originalRead;
    try {
      const sourceAfter = await sourceFingerprint(root, ['server', 'shared']), harnessAfter = await harnessFingerprint();
      if (sourceBefore.hash !== sourceAfter.hash || harnessBefore.hash !== harnessAfter.hash) failure ??= 'Source or harness changed during smoke';
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, JSON.stringify({ version: 1, startedAt, endedAt: new Date().toISOString(), success: !failure, failure,
        scope: 'Finite 24-request integration smoke on pinned production handler and unchanged minimal 100k synthetic artifact. Three 8-request bursts test actual default 16 MiB byte eviction, joining, GET/HEAD and body ownership. Original-artifact ordered selection plus ordinary paged-search metadata forms an uncached wire oracle. Natural GC; elapsed times are concurrent-host diagnostics only, not latency or peak-memory acceptance. No long soak or upstream requests.',
        root, snapshot: { path: info.path, hash: info.hash, rows: info.count, bytes: info.bytes },
        source: { before: sourceBefore, afterHash: sourceAfter.hash }, harness: { before: harnessBefore, afterHash: harnessAfter.hash },
        firstPressure, counts, dataBefore, dataAfter, oracle: Object.fromEntries(oracle), bursts, records, cacheObservations }, null, 2) + '\n', { flag: 'wx' });
    } finally { model.store.close(); }
  }
  if (failure) throw new Error(failure);
  return { output, counts, firstPressure };
}

if (args.worker === 'true') console.log(JSON.stringify({ type: 'cache-byte-pressure', ...await run() }));
else {
  try {
    const result = await runJsonChild(script, process.argv.slice(2).concat('--worker', 'true'), 'cache-byte-pressure', 90_000);
    console.log(JSON.stringify(result));
  } catch (error) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output.replace(/\.json$/, '') + '.failure.json', JSON.stringify({ at: new Date().toISOString(), output,
      error: error instanceof Error ? error.message : String(error), timeoutMs: 90_000 }, null, 2), { flag: 'wx' });
    throw error;
  }
}
