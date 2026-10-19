import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { argumentsOf, semanticHash, sha256, sourceFingerprint } from '../../../scripts/performance/common.js';
import { runJsonChild } from '../../../scripts/performance/child-process.js';

// One additional index, private in-memory databases only. No production edits,
// ANALYZE, forced index selection, artifact writes, or network requests.
const args = argumentsOf(), script = fileURLToPath(import.meta.url);
assert.ok(args.root && args.out, '--root and --out are required');
const root = resolve(args.root), output = resolve(args.out);
const indexSql = 'CREATE INDEX experiment_performances_order ON performances(classification,start_date DESC,id DESC)';
const variants = ['original', 'ordered-index'] as const;
type Variant = typeof variants[number];
const summarize = (values: number[]) => {
  assert.ok(values.length); const sorted = [...values].sort((a, b) => a - b);
  return { samples: values.length, medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0], maxMs: sorted.at(-1), valuesMs: values };
};
async function fingerprintHarness() {
  const paths = [script, ...['common.ts', 'child-process.ts', 'child-lifecycle.ts'].map(name =>
    fileURLToPath(new URL(`../../../scripts/performance/${name}`, import.meta.url)))];
  const files = Object.fromEntries(await Promise.all(paths.map(async path => [path, sha256(await readFile(path))])));
  return { hash: semanticHash(files), files };
}
async function writeNew(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
function dataState(db: any) {
  const tables = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name").all();
  const hash = createHash('sha256').update(JSON.stringify(tables));
  const comparison = createHash('sha256').update(JSON.stringify(tables));
  const counts: Record<string, number> = {};
  for (const table of tables) {
    let count = 0; hash.update(`\n${table.name}\n`); comparison.update(`\n${table.name}\n`);
    for (const row of db.prepare(`SELECT * FROM "${String(table.name).replaceAll('"', '""')}" ORDER BY rowid`).iterate()) {
      hash.update(JSON.stringify(row)).update('\n');
      // Separate fresh models legitimately have different constructor timestamps.
      // Normalize only this field for A/B comparison; each model's before/after
      // invariant still includes the complete original, unnormalized row hash.
      comparison.update(JSON.stringify(table.name === 'schema_migrations' ? { ...row, applied_at: '<model-created>' } : row)).update('\n'); count++;
    }
    counts[table.name] = count;
  }
  return { hash: hash.digest('hex'), comparisonHash: comparison.digest('hex'), counts,
    migrations: db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),
    totalChanges: Number(db.prepare('SELECT total_changes() AS n').get().n) };
}
function databasePages(db: any) {
  const pages = Number(db.prepare('PRAGMA page_count').get().page_count);
  const pageBytes = Number(db.prepare('PRAGMA page_size').get().page_size);
  return { pages, pageBytes, allocatedBytes: pages * pageBytes };
}
function stableHeaders(headers: Record<string, unknown>) {
  // Fastify's Date header follows wall clock; every other HTTP header must match.
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'date'));
}

async function worker() {
  assert.ok(args.snapshot && ['actual', 'repeated', 'minimal'].includes(args.fixture));
  const artifactPath = resolve(args.snapshot), artifactBefore = sha256(await readFile(artifactPath));
  const sourceBefore = await sourceFingerprint(root, ['server', 'shared']), harnessBefore = await fingerprintHarness();
  globalThis.fetch = async () => { throw new Error('Sort-index diagnostic forbids outbound fetch'); };
  const [{ Store }, { createApp }, { NATIONAL_CITIES }, { readPublicSnapshot, insertPublicSnapshot }] = await Promise.all([
    import(pathToFileURL(resolve(root, 'server/store.ts')).href),
    import(pathToFileURL(resolve(root, 'server/app.ts')).href),
    import(pathToFileURL(resolve(root, 'server/providers/cities.ts')).href),
    import(pathToFileURL(resolve(root, 'server/cloud/readonly-fallback.ts')).href),
  ]);
  const snapshot = await readPublicSnapshot(artifactPath);
  assert.equal(snapshot.performances.length, { actual: 5649, repeated: 22596, minimal: 100000 }[args.fixture]);
  const base = { from: snapshot.coverage.from, to: snapshot.coverage.to };
  const allCases = [
    { name: 'national', filters: base },
    { name: 'single-region', filters: { ...base, cities: 'yeosu' } },
    { name: 'multi-region', filters: { ...base, cities: 'yeosu,wonju' } },
    { name: 'genre', filters: { ...base, genre: '\uC74C\uC545' } },
    { name: 'price-age', filters: { ...base, price: 'free', age: '\uC804\uCCB4' } },
  ];
  const cases = args.fixture === 'actual' ? allCases : args.fixture === 'repeated' ? allCases.slice(0, 1)
    : [allCases[0], allCases[2]];
  const urlFor = (query: typeof allCases[number], endpoint = 'map') => `/api/${endpoint}?${new URLSearchParams(query.filters)}`;
  const models = new Map<Variant, any>(), raw: any[] = [], cold: any[] = [], functional: any[] = [], phases: any[] = [];
  const plans: any[] = [], oracles = new Map<string, any>();
  const indexes = (db: any) => db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='index' ORDER BY name").all();
  const config = { port: 4317, databasePath: ':memory:', keys: { kopis: '', culture: '' }, requestIntervalMs: 350, syncIntervalHours: 24 };
  const options = (store: any, trace?: (event: any) => void) => ({ store, providers: {}, startWorker: false, serveStatic: false,
    searchOnly: true, readonlySnapshotAt: snapshot.snapshotAt, ...(trace ? { performanceTrace: trace } : {}) });
  function verify(response: any, url: string) {
    assert.equal(response.statusCode, 200, url);
    const wire = response.rawPayload, payload = response.json();
    const actual = { status: response.statusCode, headers: stableHeaders(response.headers), hash: sha256(wire), bytes: wire.byteLength,
      items: payload.items.length, total: payload.total, truncated: payload.truncated ?? null,
      metadataHash: semanticHash({ ...payload, items: undefined }) };
    assert.ok(payload.items.length > 0, `Nontrivial selection required: ${url}`);
    if (url.startsWith('/api/map')) assert.ok(wire.byteLength <= 3 * 1024 * 1024 && payload.items.length <= 10000);
    const previous = oracles.get(url);
    if (previous) assert.deepEqual(actual, previous, `Exact wire/status/headers/metadata: ${url}`);
    else oracles.set(url, actual);
    return actual;
  }
  async function build(variant: Variant, pair: number) {
    const diagnostics: { performanceTrace?: (event: any) => void } = {};
    const started = performance.now(), memoryBefore = process.memoryUsage();
    const store = new Store(':memory:', NATIONAL_CITIES, diagnostics);
    const setupAt = performance.now(); let app: any;
    try {
      insertPublicSnapshot(store, snapshot); const insertedAt = performance.now();
      const beforePages = databasePages(store.db), indexStart = performance.now();
      if (variant === 'ordered-index') store.db.exec(indexSql);
      const indexedAt = performance.now(), afterPages = databasePages(store.db);
      store.db.exec('PRAGMA query_only=ON');
      ({ app } = await createApp(config, options(store))); await app.ready(); const readyAt = performance.now();
      const response = await app.inject({ method: 'GET', url: urlFor(allCases[0]), headers: { host: 'localhost:4317' } });
      const completedAt = performance.now(), memoryAfter = process.memoryUsage();
      verify(response, urlFor(allCases[0]));
      cold.push({ pair, variant, setupMs: setupAt - started, validatedInsertMs: insertedAt - setupAt,
        indexBuildMs: indexedAt - indexStart, routeReadyMs: readyAt - indexedAt, firstResponseMs: completedAt - readyAt,
        modelThroughFirstResponseMs: completedAt - started, beforePages, afterPages,
        additionalAllocatedBytes: afterPages.allocatedBytes - beforePages.allocatedBytes, memoryBefore, memoryAfter });
      assert.equal(store.db.prepare('PRAGMA query_only').get().query_only, 1);
      return { variant, store, app, diagnostics };
    } catch (error) { try { await app?.close(); } finally { store.close(); } throw error; }
  }
  async function close(model: any) {
    if (model.closed) return;
    try { await model.app.close(); } finally { model.store.close(); model.closed = true; }
  }
  // Capture exact SQL issued by the pinned Store only in the untimed functional pass.
  // Restore the original native method before all timing; neither SQL nor planner is forced.
  async function inspectPlans(model: any, query: typeof allCases[number], endpoint: string) {
    const db = model.store.db, descriptor = Object.getOwnPropertyDescriptor(db, 'prepare'), prepare = db.prepare.bind(db);
    const captured: any[] = [];
    Object.defineProperty(db, 'prepare', { configurable: true, writable: true, value: (sql: string) => {
      const statement = prepare(sql);
      if (!/\bperformances\b/.test(sql) || !/^\s*(SELECT|WITH)\b/i.test(sql)) return statement;
      return new Proxy(statement, { get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === 'all' || property === 'get') return (...params: any[]) => {
          captured.push({ sql, params, plan: prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) });
          return Reflect.apply(value, target, params);
        };
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    } });
    try {
      const url = urlFor(query, endpoint), response = await model.app.inject({ method: 'GET', url, headers: { host: 'localhost:4317' } });
      functional.push({ variant: model.variant, case: query.name, endpoint, ...verify(response, url) });
      plans.push({ variant: model.variant, case: query.name, endpoint, queries: captured });
      assert.ok(captured.length > 1, 'Captured row and count queries from the real Store');
    } finally { if (descriptor) Object.defineProperty(db, 'prepare', descriptor); else delete db.prepare; }
  }
  let failure: string | undefined;
  try {
    for (const variant of variants) models.set(variant, await build(variant, 0));
    const initialStates = variants.map(variant => dataState(models.get(variant).store.db));
    assert.equal(initialStates[0].comparisonHash, initialStates[1].comparisonHash, 'Only fresh-model migration timestamps may differ');
    assert.deepEqual(initialStates[0].counts, initialStates[1].counts);
    assert.equal(initialStates[0].totalChanges, initialStates[1].totalChanges);
    for (const [index, variant] of variants.entries()) {
      const model = models.get(variant); model.dataBefore = initialStates[index]; model.indexesBefore = indexes(model.store.db);
      assert.equal(model.indexesBefore.filter((row: any) => row.name === 'experiment_performances_order').length, index);
      assert.ok(model.indexesBefore.some((row: any) => row.name === 'performances_search'));
      for (const query of cases) await inspectPlans(model, query, 'map');
      if (args.fixture === 'actual') for (const query of allCases) await inspectPlans(model, query, 'performances');
    }
    // Only these uninstrumented complete Fastify responses form the warm timing series.
    for (let pair = -1; pair < 5; pair++) for (const query of cases) {
      const order = pair % 2 === 0 ? variants : [...variants].reverse();
      for (const variant of order) {
        const model = models.get(variant), url = urlFor(query);
        assert.equal(model.diagnostics.performanceTrace, undefined);
        const start = performance.now();
        const response = await model.app.inject({ method: 'GET', url, headers: { host: 'localhost:4317' } });
        const elapsedMs = performance.now() - start;
        const wire = verify(response, url);
        if (pair >= 0) raw.push({ pair, variant, case: query.name, url, elapsedMs, ...wire });
      }
    }
    // Separate attribution pass: new trace-enabled app, same read-only Store. These
    // times are never merged into the uninstrumented route or model-startup series.
    for (const variant of variants) {
      const model = models.get(variant); let events: any[] = [], traceApp: any;
      const observer = (event: any) => events.push(event); model.diagnostics.performanceTrace = observer;
      try {
        ({ app: traceApp } = await createApp(config, options(model.store, observer))); await traceApp.ready();
        for (const query of cases) {
          events = []; const url = urlFor(query);
          const response = await traceApp.inject({ method: 'GET', url, headers: { host: 'localhost:4317' } });
          verify(response, url); phases.push({ variant, case: query.name, phases: events });
        }
      } finally { model.diagnostics.performanceTrace = undefined; await traceApp?.close(); }
    }
    for (const variant of variants) {
      const model = models.get(variant); model.dataAfter = dataState(model.store.db);
      assert.deepEqual(model.dataAfter, model.dataBefore, 'Read-only route/plan/phase passes changed no data');
      assert.deepEqual(indexes(model.store.db), model.indexesBefore, 'Index definitions stayed unchanged during reads');
      assert.equal(model.store.db.prepare('PRAGMA query_only').get().query_only, 1);
    }
    for (const model of models.values()) await close(model);
    // Actual corpus: four additional fresh-model pairs (five including pair 0).
    // Large fixtures get only their one necessary construction pair, never a cold loop.
    if (args.fixture === 'actual') for (let pair = 1; pair < 5; pair++) {
      for (const variant of pair % 2 === 0 ? variants : [...variants].reverse()) {
        const model = await build(variant, pair); await close(model);
      }
    }
  } catch (error) { failure = error instanceof Error ? error.stack ?? error.message : String(error); }
  finally {
    try {
      const sourceAfter = await sourceFingerprint(root, ['server', 'shared']), harnessAfter = await fingerprintHarness();
      const artifactAfter = sha256(await readFile(artifactPath));
      if (sourceBefore.hash !== sourceAfter.hash || harnessBefore.hash !== harnessAfter.hash || artifactBefore !== artifactAfter)
        failure ??= 'Source, harness or original artifact changed during diagnostic';
      const results = cases.map(query => ({ case: query.name, filters: query.filters, variants: variants.map(variant => {
        const selected = raw.filter(row => row.case === query.name && row.variant === variant);
        return { variant, route: selected.length ? summarize(selected.map(row => row.elapsedMs)) : null,
          rows: selected[0]?.items, bytes: selected[0]?.bytes, wireHash: selected[0]?.hash };
      }), pairedSavingsMs: Array.from({ length: 5 }, (_, pair) => {
        const a = raw.find(row => row.pair === pair && row.case === query.name && row.variant === 'original');
        const b = raw.find(row => row.pair === pair && row.case === query.name && row.variant === 'ordered-index');
        return a && b ? a.elapsedMs - b.elapsedMs : null;
      }) }));
      await writeNew(output, { version: 1, at: new Date().toISOString(), success: !failure, failure, root, fixture: args.fixture,
        scope: 'Private in-memory post-load extra-index experiment. Five alternating warm pairs per case, one warm-up pair, natural GC. Whole-route no-trace timings and a single separate trace attribution pass. Fresh-model startup excludes artifact read/parse and module import; five actual-corpus model pairs, one pair per larger fixture. Not fresh-process startup, p95, latency acceptance, or peak-memory evidence. No response cache or cloud-envelope work; exact Fastify body/status/headers (except Date) compared.',
        candidate: indexSql, dataComparison: 'Cross-model comparison normalizes only schema_migrations.applied_at (constructor wall clock); each model before/after hash includes every original field without normalization.',
        source: { before: sourceBefore.hash, after: sourceAfter.hash },
        harness: { before: harnessBefore, afterHash: harnessAfter.hash }, artifact: { path: artifactPath, beforeHash: artifactBefore, afterHash: artifactAfter, rows: snapshot.performances.length },
        models: variants.filter(variant => models.has(variant)).map(variant => {
          const model = models.get(variant); return { variant, before: model.dataBefore, after: model.dataAfter, indexes: model.indexesBefore };
        }), results, coldSummary: variants.map(variant => {
          const rows = cold.filter(row => row.variant === variant);
          return { variant, modelThroughFirstResponse: rows.length ? summarize(rows.map(row => row.modelThroughFirstResponseMs)) : null,
            indexBuild: rows.length ? summarize(rows.map(row => row.indexBuildMs)) : null,
            additionalAllocatedBytes: rows.map(row => row.additionalAllocatedBytes) };
        }), cold, functional, phases, plans, raw });
    } finally {
      const cleanup = await Promise.allSettled([...models.values()].map(close));
      const rejected = cleanup.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (rejected) throw rejected.reason;
    }
  }
  if (failure) throw new Error(failure);
  return { fixture: args.fixture, output, warmRequests: raw.length, coldModels: cold.length, success: true };
}

if (args.worker === 'true') console.log(JSON.stringify({ type: 'sort-index-diagnostic', ...await worker() }));
else {
  await access(output).then(() => { throw new Error(`Refusing to replace ${output}`); }, error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
  const sourceBefore = await sourceFingerprint(root, ['server', 'shared']), harnessBefore = await fingerprintHarness();
  const directory = output.replace(/\.json$/, '') + '-runs';
  const fixtures = [
    { fixture: 'actual', snapshot: resolve(root, 'server/assets/public-snapshot.json') },
    { fixture: 'repeated', snapshot: resolve('data/performance-session-20261019/scale-22596.json') },
    { fixture: 'minimal', snapshot: resolve('data/performance-session-20261019/minimal-100000.json') },
  ];
  const results: any[] = [];
  try {
    for (const fixture of fixtures) {
      const childOutput = resolve(directory, `${fixture.fixture}.json`);
      const result = await runJsonChild(script, ['--worker', 'true', '--root', root, '--fixture', fixture.fixture,
        '--snapshot', fixture.snapshot, '--out', childOutput], 'sort-index-diagnostic', 180_000);
      results.push(result); console.log(JSON.stringify({ completed: fixture.fixture, ...result }));
    }
    const sourceAfter = await sourceFingerprint(root, ['server', 'shared']), harnessAfter = await fingerprintHarness();
    assert.equal(sourceAfter.hash, sourceBefore.hash); assert.equal(harnessAfter.hash, harnessBefore.hash);
    await writeNew(output, { at: new Date().toISOString(), success: true, root, source: sourceBefore.hash,
      harness: harnessBefore, candidate: indexSql, results });
  } catch (error) {
    await writeNew(output + '.failure.json', { at: new Date().toISOString(), results, error: String(error), timeoutPerWorkerMs: 180_000 });
    throw error;
  }
}
