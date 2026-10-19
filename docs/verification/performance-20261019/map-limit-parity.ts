import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { argumentsOf, semanticHash, sha256, sourceFingerprint, workspace } from '../../../scripts/performance/common.js';
import type { SearchFilters } from '../../../shared/types.js';

const args = argumentsOf();
if (!args.baseline || !args.snapshot || !args.out) throw new Error('--baseline, --snapshot and --out required');
const roots = [resolve(args.baseline), resolve(args.root ?? workspace)];
globalThis.fetch = async () => { throw new Error('Map parity forbids outbound fetch'); };
const before = await Promise.all(roots.map(root => sourceFingerprint(root, ['server', 'shared'])));
const snapshotPath = resolve(args.snapshot), snapshotHash = sha256(await readFile(snapshotPath));
const modules = await Promise.all(roots.map(async root => {
  const readonly = await import(pathToFileURL(resolve(root, 'server/cloud/readonly-fallback.ts')).href);
  const response = await import(pathToFileURL(resolve(root, 'server/map-response.ts')).href);
  return { ...readonly, ...response };
}));
const snapshot = await modules[0].readPublicSnapshot(snapshotPath);
const models = modules.map(module => module.hydrateReadonlySnapshot(snapshot));
const cases: { name: string; filters: SearchFilters }[] = [
  { name: 'national', filters: {} }, { name: 'regional', filters: { cities: 'yeosu,wonju' } },
  { name: 'source', filters: { source: 'culture' } }, { name: 'text', filters: { q: '음악' } },
  { name: 'admission', filters: { price: 'free', age: '전체' } }, { name: 'bookmarks-empty', filters: { bookmarked: 'true' } },
];
const results: unknown[] = [];
try {
  for (const query of cases) {
    const filters = { from: snapshot.coverage.from, to: snapshot.coverage.to, ...query.filters };
    const selected = models.map(model => model.store.searchMap(filters));
    const bodies = selected.map((result, index) => JSON.stringify(modules[index].buildMapResult({ ...result, snapshotAt: snapshot.snapshotAt })));
    assert.equal(bodies[1], bodies[0], `${query.name}: exact final map envelope`);
    const payload = JSON.parse(bodies[1]);
    assert.equal(payload.truncated, payload.items.length < selected[0].items.length);
    assert.ok(payload.items.length <= modules[1].MAP_MAX_ITEMS && Buffer.byteLength(bodies[1]) <= modules[1].MAP_MAX_BYTES);
    results.push({ name: query.name, filters, priorSelectedRows: selected[0].items.length, candidateMaterializedRows: selected[1].items.length,
      returnedRows: payload.items.length, total: payload.total, sourceCounts: payload.sourceCounts, pendingDetails: payload.pendingDetails,
      partial: payload.partial, truncated: payload.truncated, bytes: Buffer.byteLength(bodies[1]),
      wireHash: sha256(bodies[1]), semanticHash: semanticHash(payload) });
  }
  for (const model of models) assert.equal(model.store.db.prepare('PRAGMA query_only').get().query_only, 1);
} finally { for (const model of models) model.store.close(); }
const after = await Promise.all(roots.map(root => sourceFingerprint(root, ['server', 'shared'])));
after.forEach((fingerprint, index) => assert.equal(fingerprint.hash, before[index].hash));
const report = { at: new Date().toISOString(), roots, source: before.map((fingerprint, index) => ({ before: fingerprint.hash, after: after[index].hash })),
  snapshot: { path: snapshotPath, hash: snapshotHash, rows: snapshot.performances.length },
  scope: 'Functional comparison of prior pinned Store/map response and current candidate on the same actual-content derived artifact. No latency or memory claim. Positive bookmarks and historical sources are covered separately by Store unit tests.',
  results };
await writeFile(resolve(args.out), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ out: resolve(args.out), cases: results.length, equal: true }));
