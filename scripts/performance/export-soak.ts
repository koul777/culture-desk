import assert from 'node:assert/strict';
import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { argumentsOf, saveJson, semanticHash, sha256, snapshotInfo, sourceFingerprint, workspace } from './common.js';
import { workbookSemantics } from './workbook.js';
import { runJsonChild } from './child-process.js';

// Repeated exports exercise archive lifecycle in one process. Natural GC and
// scheduled gaps are intentional: this measures stability, not throughput.
const args = argumentsOf(), root = resolve(args.root ?? workspace);
assert.ok(args.out, '--out is required');
const minutes = Number(args.minutes ?? 30), intervalMs = Number(args.interval ?? 20_000);
const maxWallMs = Number(args['max-wall-minutes'] ?? minutes + 30) * 60_000;
assert.ok(Number.isFinite(minutes) && minutes > 0 && minutes <= 120);
assert.ok(Number.isSafeInteger(intervalMs) && intervalMs >= 1000 && intervalMs <= 60_000);
assert.ok(Number.isFinite(maxWallMs) && maxWallMs >= minutes * 60_000 && maxWallMs <= 180 * 60_000);
const output = resolve(args.out), samplesFile = output.replace(/\.json$/, '') + '.ndjson';
const control = args.control ? resolve(args.control) : undefined;
async function runWorker() {
const fingerprintHarness = async () => {
  const names = ['export-soak.ts', 'workbook.ts', 'common.ts', 'child-process.ts', 'child-lifecycle.ts'];
  const files = Object.fromEntries(await Promise.all(names.map(async name => [name, sha256(await readFile(new URL(name, import.meta.url)))])));
  return { files, hash: semanticHash(files) };
};
const harnessBefore = await fingerprintHarness();
for (const path of [output, samplesFile]) await access(path).then(() => { throw new Error(`Refusing to replace ${path}`); }, error => {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
});
await mkdir(dirname(output), { recursive: true });
await writeFile(samplesFile, '', { flag: 'wx' });
const info = await snapshotInfo(root, args.snapshot), before = await sourceFingerprint(root, ['server', 'shared']);
globalThis.fetch = async () => { throw new Error('Export soak forbids outbound fetch'); };
const { hydrateReadonlySnapshot } = await import(pathToFileURL(resolve(root, 'server/cloud/readonly-fallback.ts')).href);
const { exportWorkbook } = await import(pathToFileURL(resolve(root, 'server/export.ts')).href);
const model = hydrateReadonlySnapshot(info.snapshot);
const databaseHash = () => sha256(JSON.stringify(model.store.db.prepare('SELECT * FROM performances ORDER BY id').all()));
const dataBefore = databaseHash();
const filters = { from: info.snapshot.coverage.from, to: info.snapshot.coverage.to };
const startedAt = new Date().toISOString(), start = performance.now(), raw: any[] = [];
let activeMs = 0, pausedMs = 0, cycles = 0, failure: string | undefined;
let first: Buffer | undefined, latest: Buffer | undefined;
let semantics: { first: string; last: string; rows: number } | undefined;
let lastOutput = 0, previousState = '', lastLogged = start;
async function sample(state: string, exportMs?: number) {
  const entry = { at: new Date().toISOString(), state, wallMs: performance.now() - start,
    activeMs, pausedMs, cycles, exportMs, outputBytes: lastOutput,
    retainedVerificationBuffers: (first?.length ?? 0) + (latest === first ? 0 : latest?.length ?? 0),
    memory: process.memoryUsage(), activeResources: process.getActiveResourcesInfo().sort() };
  raw.push(entry);
  await appendFile(samplesFile, JSON.stringify(entry) + '\n');
  if (state !== previousState || performance.now() - lastLogged >= 60_000) {
    previousState = state; lastLogged = performance.now(); console.log(JSON.stringify(entry));
  }
}
try {
  await sample('hydrated');
  while (activeMs < minutes * 60_000 && performance.now() - start < maxWallMs) {
    let paused = false;
    if (control) {
      try { paused = JSON.parse((await readFile(control, 'utf8')).replace(/^\uFEFF/, '')).paused === true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (paused) {
      if (previousState !== 'paused' || performance.now() - lastLogged >= 60_000) await sample('paused');
      const tick = performance.now(); await delay(500); pausedMs += performance.now() - tick; continue;
    }
    const tick = performance.now();
    const buffer: Buffer = await exportWorkbook(model.store, filters, undefined, { includeNotes: false });
    latest = buffer;
    const exportMs = performance.now() - tick;
    assert.ok(buffer.length > 100 && buffer.subarray(0, 2).toString() === 'PK', 'Expected XLSX ZIP output');
    if (!first) first = buffer;
    // Zip timestamps may differ; stable semantic verification follows the series.
    assert.ok(Math.abs(buffer.length - first.length) <= 4096, 'Unexpected workbook size drift');
    lastOutput = buffer.length; cycles++;
    assert.equal(model.store.db.prepare('PRAGMA query_only').get()!.query_only, 1);
    await sample('export-complete', exportMs);
    await delay(Math.max(0, intervalMs - (performance.now() - tick)));
    activeMs += performance.now() - tick;
    await sample('settled');
  }
  assert.ok(activeMs >= minutes * 60_000, 'Wall limit before active duration completed');
  assert.ok(first && latest && cycles >= 1);
  // No parser allocations enter the recorded steady-workload memory series.
  const initial = await workbookSemantics(first), final = await workbookSemantics(latest);
  assert.equal(initial.payload.exportedRows, info.count);
  assert.equal(final.payload.exportedRows, info.count);
  semantics = { first: semanticHash(initial.payload), last: semanticHash(final.payload), rows: info.count };
  assert.equal(semantics.first, semantics.last, 'First and last exports have identical semantics');
  assert.equal(databaseHash(), dataBefore, 'Read-only rows unchanged');
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  try {
  const after = await sourceFingerprint(root, ['server', 'shared']);
  const harnessAfter = await fingerprintHarness();
  if (after.hash !== before.hash) failure ??= 'Pinned source changed during soak';
  if (harnessAfter.hash !== harnessBefore.hash) failure ??= 'Measurement harness changed during soak';
  await saveJson(output, { startedAt, endedAt: new Date().toISOString(), root, node: process.version,
    scope: 'Sequential exports in one process with natural GC and scheduled gaps. Post-export/settled observations are not peak-memory measurements. First and latest output buffers are deliberately retained and accounted. Final workbook parsing/database integrity verification are outside the memory series. Diagnostic latency only.',
    requestedMinutes: minutes, intervalMs, activeMs, pausedMs, wallMs: performance.now() - start,
    cycles, success: !failure, failure, snapshot: { hash: info.hash, rows: info.count },
    source: { before, afterHash: after.hash },
    harness: { before: harnessBefore, afterHash: harnessAfter.hash }, semantics, raw });
  } finally { model.store.close(); }
}
if (failure) throw new Error(failure);
console.log(JSON.stringify({ type: 'export-soak-result', out: output, success: true, cycles, activeMinutes: activeMs / 60_000 }));
}

if (args.worker === 'true') await runWorker();
else {
  // The watchdog lives outside the worker, so a stuck archive or synchronous
  // parser cannot prevent it from terminating its owned worker process.
  try {
    const result = await runJsonChild(fileURLToPath(import.meta.url),
      [...process.argv.slice(2), '--worker', 'true'], 'export-soak-result', maxWallMs + 180_000);
    console.log(JSON.stringify(result));
  } catch (error) {
    await saveJson(output + '.failure.json', { at: new Date().toISOString(), error: String(error),
      partialSeries: samplesFile, root, maxWallMs, verificationAllowanceMs: 180_000 });
    throw error;
  }
}
