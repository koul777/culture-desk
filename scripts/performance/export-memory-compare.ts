import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argumentsOf, saveJson, semanticHash, sha256, snapshotInfo, sourceFingerprint, workspace } from './common.js';
import { runJsonChild } from './child-process.js';

// Compare independently instrumented fresh processes. The measured operation is
// export memory, not latency: semantic workbook reload happens after sampling.
const args = argumentsOf();
assert.ok(args.baseline && args.root && args.out, '--baseline, --root and --out are required');
const samples = Number(args.samples ?? 5);
assert.ok(Number.isSafeInteger(samples) && samples >= 3 && samples <= 20, '--samples must be 3–20 pairs');
const output = resolve(args.out);
await access(output).then(() => { throw new Error(`Refusing to replace ${output}`); }, error => {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
});
const runDirectory = output.slice(0, output.length - extname(output).length) + '-runs';
await access(runDirectory).then(() => { throw new Error(`Refusing to replace ${runDirectory}`); }, error => {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
});
const variants = [{ name: 'baseline', root: resolve(args.baseline) }, { name: 'candidate', root: resolve(args.root) }];
const corpus = await snapshotInfo(variants[0].root, args.snapshot);
assert.equal((await snapshotInfo(variants[1].root, args.snapshot)).hash, corpus.hash, 'Different snapshot corpora');
const before = await Promise.all(variants.map(v => sourceFingerprint(v.root, ['server', 'shared'])));
const child = fileURLToPath(new URL('./export-memory.ts', import.meta.url));
const fingerprintHarness = async () => {
  const names = ['export-memory-compare.ts', 'export-memory.ts', 'workbook.ts', 'common.ts', 'child-process.ts', 'child-lifecycle.ts'];
  const files = Object.fromEntries(await Promise.all(names.map(async name => [name, sha256(await readFile(new URL(name, import.meta.url)))])));
  return { files, hash: semanticHash(files) };
};
const harnessBefore = await fingerprintHarness();
const raw: any[] = [];
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const summary = () => variants.map(variant => {
  const rows = raw.filter(row => row.variant === variant.name);
  return { variant: variant.name, samples: rows.length,
    peaks: Object.fromEntries(['rss', 'heapUsed', 'external', 'arrayBuffers'].map(metric => {
      const values = rows.map(row => row.peaks[metric] / 1024 / 1024);
      return [metric, values.length ? { medianMiB: median(values), minMiB: Math.min(...values), maxMiB: Math.max(...values), rawMiB: values } : null];
    })),
    outputBytes: rows.map(row => row.output.bytes),
  };
});
try {
  for (let round = 0; round < samples; round++) {
    const order = round % 2 === 0 ? variants : [...variants].reverse();
    for (const variant of order) {
      const sampleOut = resolve(runDirectory, `${round}-${variant.name}.json`);
      const params = ['--root', variant.root, '--out', sampleOut, ...(args.snapshot ? ['--snapshot', resolve(args.snapshot)] : [])];
      const result = await runJsonChild(child, params, 'export-memory-result', 180_000);
      assert.equal(result.snapshotHash, corpus.hash);
      assert.equal(result.sourceHash, before[variants.indexOf(variant)].hash);
      assert.equal(result.output.rows, corpus.count);
      raw.push({ round, variant: variant.name, at: new Date().toISOString(), ...result });
    }
    assert.equal(new Set(raw.map(row => row.output.semanticHash)).size, 1, 'Workbook semantic mismatch');
    await saveJson(output + '.partial.json', { completedPairs: round + 1, summary: summary(), raw });
    console.log(JSON.stringify({ completedPairs: round + 1, totalPairs: samples, rows: corpus.count }));
  }
  const after = await Promise.all(variants.map(v => sourceFingerprint(v.root, ['server', 'shared'])));
  after.forEach((fingerprint, i) => assert.equal(fingerprint.hash, before[i].hash, 'Source changed during comparison'));
  const harnessAfter = await fingerprintHarness();
  assert.equal(harnessAfter.hash, harnessBefore.hash, 'Measurement harness changed during comparison');
  const report = { at: new Date().toISOString(), node: process.version, workspace, samples, variants,
    scope: 'AB/BA paired fresh processes, natural GC, ExcelJS preloaded. Peak memory includes the hydrated snapshot. Row-creation instrumentation and 100 ms asynchronous samples can miss between-sample peaks. Semantic verification is outside the memory series. No p95 or latency acceptance claim.',
    snapshot: { hash: corpus.hash, bytes: corpus.bytes, rows: corpus.count },
    source: variants.map((v, i) => ({ variant: v.name, before: before[i], afterHash: after[i].hash })),
    harness: { before: harnessBefore, afterHash: harnessAfter.hash },
    equal: true, summary: summary(), raw,
  };
  await saveJson(output, report);
  console.log(JSON.stringify({ out: output, summary: report.summary }));
} catch (error) {
  await saveJson(output + '.failure.json', { error: String(error), variants, raw });
  throw error;
}
