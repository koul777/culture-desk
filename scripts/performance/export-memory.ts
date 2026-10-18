import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { argumentsOf, saveJson, semanticHash, snapshotInfo, sourceFingerprint, workspace } from './common.js';
import { workbookSemantics } from './workbook.js';

// Attribution only: instrument workbook row creation to observe synchronous memory
// peaks that a timer in the same busy event loop would miss. Do not time this as an
// uninstrumented user latency benchmark.
const args = argumentsOf(), root = resolve(args.root ?? workspace);
assert.ok(args.out, '--out is required');
const info = await snapshotInfo(root, args.snapshot), before = await sourceFingerprint(root, ['server', 'shared']);
globalThis.fetch = async () => { throw new Error('Export memory probe forbids outbound fetch'); };
const { default: ExcelJS } = await import('exceljs');
const raw: any[] = [], start = performance.now();
let insertedRows = 0;
const sample = (phase: string) => raw.push({ phase, elapsedMs: performance.now() - start, insertedRows, memory: process.memoryUsage() });
const restore: (() => void)[] = [];
for (const constructor of [ExcelJS.Workbook, ExcelJS.stream.xlsx.WorkbookWriter] as any[]) {
  const original = constructor.prototype.addWorksheet;
  constructor.prototype.addWorksheet = function (...parameters: any[]) {
    const sheet = original.apply(this, parameters);
    const addRow = sheet.addRow;
    sheet.addRow = function (...values: any[]) {
      const row = addRow.apply(this, values);
      insertedRows++;
      if (insertedRows % 1000 === 0) sample('rows');
      return row;
    };
    return sheet;
  };
  restore.push(() => { constructor.prototype.addWorksheet = original; });
}
const { hydrateReadonlySnapshot } = await import(pathToFileURL(resolve(root, 'server/cloud/readonly-fallback.ts')).href);
const { exportWorkbook } = await import(pathToFileURL(resolve(root, 'server/export.ts')).href);
const model = hydrateReadonlySnapshot(info.snapshot);
sample('hydrated');
let timer: ReturnType<typeof setInterval> | undefined;
try {
  timer = setInterval(() => sample('async-serialization'), 100);
  const filters = { from: info.snapshot.coverage.from, to: info.snapshot.coverage.to };
  const bytes = await exportWorkbook(model.store, filters, undefined, { includeNotes: false });
  clearInterval(timer); timer = undefined;
  sample('serialized');
  for (const reset of restore) reset();
  await saveJson(args.out + '.partial.json', { verificationPending: true, snapshotHash: info.hash, outputBytes: bytes.length, raw });
  // Semantic parsing deliberately happens after the export memory series ends.
  const semantics = await workbookSemantics(bytes);
  assert.equal(semantics.payload.exportedRows, info.count, 'Every public row was exported');
  const after = await sourceFingerprint(root, ['server', 'shared']);
  assert.equal(before.hash, after.hash, 'Source changed during probe');
  const report = { at: new Date().toISOString(), root, node: process.version,
    scope: 'Instrumented direct export memory attribution with ExcelJS preloaded. Natural GC; memory includes hydrated snapshot. Semantic reload/hash excluded from series. Not cold-start or isolated latency acceptance.',
    snapshot: { hash: info.hash, rows: info.count, bytes: info.bytes }, source: before,
    output: { bytes: bytes.length, semanticHash: semanticHash(semantics.payload), rows: semantics.payload.exportedRows },
    peaks: { rss: Math.max(...raw.map(row => row.memory.rss)), heapUsed: Math.max(...raw.map(row => row.memory.heapUsed)),
      external: Math.max(...raw.map(row => row.memory.external)), arrayBuffers: Math.max(...raw.map(row => row.memory.arrayBuffers)) }, raw };
  await saveJson(args.out, report);
  console.log(JSON.stringify({ type: 'export-memory-result', out: args.out, rows: info.count,
    snapshotHash: info.hash, sourceHash: before.hash, output: report.output, peaks: report.peaks,
    hydratedMemory: raw[0].memory }));
} finally {
  if (timer) clearInterval(timer);
  for (const reset of restore) reset();
  model.store.close();
}
