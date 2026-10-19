import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { argumentsOf, semanticHash, sha256, sourceFingerprint, statistics, workspace } from '../../../scripts/performance/common.js';
import type { SearchFilters } from '../../../shared/types.js';

// Offline diagnostic only. Run in a coordinated window after the browser work has stopped.
// Example: node --expose-gc --import tsx docs/verification/performance-20261019/map-limit-variants.ts
//   --snapshot data/performance-session-20261019/scale-22596.json --samples 3 --out <new-report.json>
// --take supports functional 0/9999/10000/10001/100000 boundaries without another artifact copy.
const args = argumentsOf(), root = resolve(args.root ?? workspace);
if (!args.snapshot || !args.out) throw new Error('--snapshot and --out are required');
const samples = Number(args.samples ?? '3'), warmup = Number(args.warmup ?? '1');
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 10 || !Number.isSafeInteger(warmup) || warmup < 0 || warmup > 2) throw new Error('Invalid short diagnostic sample count');
const [{ readPublicSnapshot, hydrateReadonlySnapshot }, { MAP_ROW_COLUMNS, mapQueryRow }, { buildMapResult, MAP_MAX_ITEMS, MAP_MAX_BYTES }] = await Promise.all([
  import(pathToFileURL(resolve(root, 'server/cloud/readonly-fallback.ts')).href),
  import(pathToFileURL(resolve(root, 'server/map-query.ts')).href),
  import(pathToFileURL(resolve(root, 'server/map-response.ts')).href),
]);
globalThis.fetch = async () => { throw new Error('Map SQL diagnostic forbids outbound fetch'); };
const sourceBefore = await sourceFingerprint(root, ['server', 'shared']);
const artifactPath = resolve(args.snapshot);
const artifactFileBytes = (await stat(artifactPath)).size;
let snapshot = await readPublicSnapshot(artifactPath);
const originalRows = snapshot.performances.length;
if (args.take !== undefined) {
  const take = Number(args.take);
  if (!Number.isSafeInteger(take) || take < 0 || take > originalRows) throw new Error('--take exceeds the available valid artifact rows');
  snapshot = { ...snapshot, performances: snapshot.performances.slice(0, take) };
}
const hydrationStart = performance.now();
const { store } = hydrateReadonlySnapshot(snapshot);
const hydrationMs = performance.now() - hydrationStart;
const sentinel = MAP_MAX_ITEMS + 1;
const names = (args.cases ?? 'national').split(',');
const allCases: { name: string; filters: SearchFilters }[] = [
  { name: 'national', filters: {} }, { name: 'regional', filters: { cities: 'yeosu,wonju' } },
  { name: 'source', filters: { source: 'culture' } }, { name: 'text', filters: { q: '음악' } },
  { name: 'admission', filters: { price: 'free', age: '전체' } }, { name: 'bookmarks', filters: { bookmarked: 'true' } },
];
const cases = allCases.filter(query => names.includes(query.name));
if (cases.length !== names.length) throw new Error('Unknown or duplicate case');

function selection(filters: SearchFilters) {
  const clauses = ["p.classification='performance'"], params: (string | number)[] = [];
  const cities = filters.cities?.split(',').filter(Boolean) || [];
  if (cities.length) { clauses.push(`p.city_id IN (${cities.map(() => '?').join(',')})`); params.push(...cities); }
  if (filters.from) { clauses.push('p.end_date>=?'); params.push(filters.from); }
  if (filters.to) { clauses.push('p.start_date<=?'); params.push(filters.to); }
  if (filters.source) { clauses.push('p.source=?'); params.push(filters.source); }
  if (filters.q) { clauses.push("instr(lower(json_extract(p.data,'$.title') || ' ' || json_extract(p.data,'$.venue')),lower(?))>0"); params.push(filters.q); }
  if (filters.price) { clauses.push("p.detail_state='complete' AND json_extract(p.data,'$.priceType')=?"); params.push(filters.price); }
  if (filters.age) { clauses.push("p.detail_state='complete' AND instr(json_extract(p.data,'$.age'),?)>0"); params.push(filters.age); }
  if (filters.bookmarked === 'true') clauses.push('b.performance_id IS NOT NULL');
  return { sql: `FROM performances p LEFT JOIN bookmarks b ON b.performance_id=p.id WHERE ${clauses.join(' AND ')}`, params };
}

const raw: any[] = [], plans: any[] = [];
try {
  for (const query of cases) {
    const filters = { from: snapshot.coverage?.from, to: snapshot.coverage?.to, ...query.filters };
    const metadata = store.search(filters);
    const base = selection(filters), order = 'ORDER BY p.start_date DESC,p.id DESC';
    // Public total historically sums the two known sources only. A local Store can
    // also select historical/unknown sources, so row/truncation oracles use SQL count.
    // Keep metadata.total/sourceCounts untouched for exact baseline wire comparison.
    const selectedCount = Number(store.db.prepare(`SELECT count(*) AS n ${base.sql}`).get(...base.params).n);
    const variants = [
      { name: 'full', sql: `SELECT ${MAP_ROW_COLUMNS} ${base.sql} ${order}`, params: base.params },
      { name: 'limit', sql: `SELECT ${MAP_ROW_COLUMNS} ${base.sql} ${order} LIMIT ?`, params: [...base.params, sentinel] },
      { name: 'cte', sql: `WITH selected AS MATERIALIZED (SELECT p.id,p.start_date ${base.sql} ${order} LIMIT ?)
        SELECT ${MAP_ROW_COLUMNS} FROM selected JOIN performances p ON p.id=selected.id ${order}`, params: [...base.params, sentinel] },
    ];
    plans.push({ case: query.name, variants: variants.map(variant => ({ ...variant,
      plan: store.db.prepare(`EXPLAIN QUERY PLAN ${variant.sql}`).all(...variant.params) })) });
    let expectedWire: string | undefined, expectedSemantic: string | undefined;
    for (let index = -warmup; index < samples; index++) for (let offset = 0; offset < variants.length; offset++) {
      const variant = variants[(index + warmup + offset) % variants.length];
      globalThis.gc?.();
      const before = process.memoryUsage();
      const started = performance.now();
      const rows = store.db.prepare(variant.sql).all(...variant.params);
      const queried = performance.now(), afterQuery = process.memoryUsage();
      const projectStart = performance.now();
      const items = rows.map(mapQueryRow);
      const projected = performance.now(), afterProjection = process.memoryUsage();
      const budgetStart = performance.now();
      const response = buildMapResult({ ...metadata, items, snapshotAt: snapshot.snapshotAt });
      const budgeted = performance.now(), afterBudget = process.memoryUsage();
      const serializeStart = performance.now();
      const wire = JSON.stringify(response);
      const serialized = performance.now();
      const bytes = Buffer.byteLength(wire), wireHash = sha256(wire), payloadHash = semanticHash(JSON.parse(wire));
      expectedWire ??= wireHash; expectedSemantic ??= payloadHash;
      assert.equal(wireHash, expectedWire, `${query.name}/${variant.name}: exact wire parity`);
      assert.equal(payloadHash, expectedSemantic, `${query.name}/${variant.name}: exact semantic parity`);
      assert.equal(rows.length, variant.name === 'full' ? selectedCount : Math.min(selectedCount, sentinel), 'Selection covers the same matching rows');
      assert.equal(response.truncated, response.items.length < selectedCount);
      assert.ok(response.items.length <= MAP_MAX_ITEMS && bytes <= MAP_MAX_BYTES);
      if (index >= 0) raw.push({ case: query.name, variant: variant.name, index,
        sqlMs: queried - started, projectMs: projected - projectStart, budgetMs: budgeted - budgetStart,
        serializeMs: serialized - serializeStart, totalMs: serialized - started,
        materializedRows: rows.length, selectedRows: selectedCount, returnedRows: response.items.length, total: response.total,
        bytes, truncated: response.truncated, wireHash, semanticHash: payloadHash,
        memory: { before, afterQuery, afterProjection, afterBudget } });
    }
  }
  assert.equal(store.db.prepare('PRAGMA query_only').get()!.query_only, 1);
} finally { store.close(); }
const sourceAfter = await sourceFingerprint(root, ['server', 'shared']);
assert.equal(sourceAfter.hash, sourceBefore.hash, 'Source changed during diagnostic');
const results = cases.map(query => ({ case: query.name, variants: ['full', 'limit', 'cte'].map(name => {
  const selected = raw.filter(sample => sample.case === query.name && sample.variant === name);
  return { name, materializedRows: selected[0].materializedRows, selectedRows: selected[0].selectedRows, returnedRows: selected[0].returnedRows,
    total: selected[0].total, bytes: selected[0].bytes, truncated: selected[0].truncated,
    sql: statistics(selected.map(sample => sample.sqlMs)), project: statistics(selected.map(sample => sample.projectMs)),
    budget: statistics(selected.map(sample => sample.budgetMs)), serialize: statistics(selected.map(sample => sample.serializeMs)),
    elapsed: statistics(selected.map(sample => sample.totalMs)), wireHash: selected[0].wireHash };
}) }));
const report = { version: 1, measuredAt: new Date().toISOString(), root, source: sourceBefore.hash,
  scope: 'Offline SQL/projection/budget/serialization attribution. Alternating variants; optional explicit GC only before each variant. Memory entries are observation points, not per-variant RSS peaks. Not an HTTP or cold-start acceptance benchmark.',
  artifactPath, artifactFileBytes, originalRows, effectiveRows: snapshot.performances.length, take: args.take ?? null,
  samples, warmup, explicitGc: typeof globalThis.gc === 'function', hydrationMs, sentinel, results, plans, raw };
const destination = resolve(args.out);
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ out: destination, effectiveRows: report.effectiveRows, hydrationMs, results }, null, 2));
