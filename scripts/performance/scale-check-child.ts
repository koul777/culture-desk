import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { argumentsOf, saveJson, semanticHash, snapshotInfo, sourceFingerprint, workspace } from './common.js';

const args = argumentsOf(), root = resolve(args.root ?? workspace);
if (!args.snapshot || !args.out) throw new Error('--snapshot and --out are required');
const info = await snapshotInfo(root, args.snapshot), before = await sourceFingerprint(root, ['server', 'shared']);
assert.equal(new Set(info.snapshot.performances.map((row: any) => row.id)).size, info.count, 'Unique numeric IDs');
assert.equal(new Set(info.snapshot.performances.map((row: any) => `${row.source}:${row.sourceId}`)).size, info.count, 'Unique provider IDs');
assert.ok(info.snapshot.performances.every((row: any) => row.source === 'kopis' || row.source === 'culture'), 'This corpus-count oracle requires the two published providers; historical/unknown source fixtures need a selected-row oracle');
assert.ok(info.bytes <= 64 * 1024 * 1024, 'Fixture within 64 MiB decoded UTF-8 public artifact budget');
globalThis.fetch = async () => { throw new Error('Scale check forbids upstream fetch'); };
const { handleCloudRequest } = await import(pathToFileURL(resolve(root, 'server/cloud/handler.ts')).href);
const options = { env: {}, readonlyFallback: { artifactPath: info.path } };
const query = new URLSearchParams({ from: info.snapshot.coverage.from, to: info.snapshot.coverage.to });
const expectedOrder = [...info.snapshot.performances].sort((a: any, b: any) => b.startDate.localeCompare(a.startDate) || b.id - a.id);
const expectedPending = info.snapshot.performances.filter((row: any) => row.detailState === 'pending').length;
const markerKeys = ['id', 'title', 'venue', 'cityId', 'startDate', 'endDate', 'latitude', 'longitude', 'locationPrecision', 'source'];
const rows: any[] = [];
for (const endpoint of ['performances', 'map']) {
  const response = await handleCloudRequest(new Request(`http://scale.test/api/${endpoint}?${query}`), options);
  assert.equal(response.status, 200, endpoint);
  const bytes = Buffer.from(await response.arrayBuffer()), value = JSON.parse(bytes.toString('utf8'));
  assert.equal(value.total, info.count, 'Derived fixture totals');
  assert.equal(value.snapshotAt, info.snapshot.snapshotAt, 'Immutable snapshot time');
  assert.equal(value.sourceCounts.kopis + value.sourceCounts.culture, info.count, 'Source totals');
  assert.equal(value.pendingDetails, expectedPending, 'Pending detail count reflects the fixture');
  assert.equal(new Set(value.items.map((row: any) => row.id)).size, value.items.length, 'No duplicated response IDs');
  assert.deepEqual(value.items.map((row: any) => row.id), expectedOrder.slice(0, value.items.length).map((row: any) => row.id), 'Ordered prefix is preserved');
  if (endpoint === 'map') {
    assert.ok(bytes.length <= 3 * 1024 * 1024, `Final HTTP body budget exceeded: ${bytes.length}`);
    assert.ok(value.items.length <= 10000, 'Marker item budget');
    assert.equal(value.truncated, value.items.length < value.total, 'Truncation disclosure');
    for (const row of value.items) assert.ok(!('description' in row) && !('note' in row) && !('venueInfo' in row), 'Minimal map payload');
    const expectedMarkers = expectedOrder.slice(0, value.items.length).map((row: any) => Object.fromEntries(markerKeys.filter(key => row[key] !== undefined).map(key => [key, row[key]])));
    assert.deepEqual(value.items, expectedMarkers, 'Complete marker fields and missing-value semantics are preserved');
  }
  rows.push({ endpoint, status: response.status, bytes: bytes.length, items: value.items.length, total: value.total, truncated: value.truncated,
    semanticHash: semanticHash(value), metadata: { total: value.total, sourceCounts: value.sourceCounts, pendingDetails: value.pendingDetails,
      partial: value.partial, snapshotAt: value.snapshotAt, published: value.published },
    firstId: value.items[0]?.id, lastId: value.items.at(-1)?.id });
}
assert.deepEqual(rows[0].metadata, rows[1].metadata, 'List/map metadata agree');
const after = await sourceFingerprint(root, ['server', 'shared']);
assert.equal(before.hash, after.hash, 'Pinned source unchanged');
await saveJson(args.out, { version: 1, measuredAt: new Date().toISOString(), root,
  scope: 'Functional scale and artifact-budget check, not latency measurement. Uses actual artifact loader and generated full-coverage kopis/culture-only corpus; it is not an oracle for historical/unknown providers. Exact ordered prefix, complete marker fields, pending counts, metadata, item and final UTF-8 HTTP budget invariants.',
  snapshot: { hash: info.hash, rows: info.count, bytes: info.bytes }, source: { before, afterHash: after.hash, stable: true }, rows });
console.log(JSON.stringify({ out: args.out, snapshotRows: info.count, rows }, null, 2));
