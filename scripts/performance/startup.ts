import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argumentsOf, coreRoutes, saveJson, snapshotInfo, sourceFingerprint, statistics, workspace } from './common.js';
import { runJsonChild } from './child-process.js';

const args = argumentsOf();
const root = resolve(args.root ?? workspace);
if (!args.out) throw new Error('--out is required');
if (args['compare-root']) {
  const { compareStartup } = await import('./startup-compare.js');
  await compareStartup({ ...args, baseline: root, root: args['compare-root'] });
} else {
const samples = Number(args.samples ?? '10');
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 200) throw new Error('samples must be 1–200');
const info = await snapshotInfo(root);
const sourceBefore = await sourceFingerprint(root, ['server', 'shared']);
const route = args.route ?? coreRoutes(info.snapshot)[1].route;
const childPath = fileURLToPath(new URL('./startup-child.ts', import.meta.url));
const raw: any[] = [];
try {
for (let i = 0; i < samples; i++) {
  const startedAt = new Date().toISOString();
  const result = await runJsonChild(childPath, ['--root', root, '--route', route], 'startup-result');
  raw.push({ index: i, startedAt, ...result });
}
} catch (error) {
  await saveJson(args.out + '.failure.json', { measuredAt: new Date().toISOString(), root, route, requestedSamples: samples, raw, error: String(error) });
  throw error;
}
if (new Set(raw.map(row => row.semanticHash)).size !== 1) throw new Error('Startup responses differ');
const sourceAfter = await sourceFingerprint(root, ['server', 'shared']);
const report = { version: 2, measuredAt: new Date().toISOString(), variant: args.variant ?? root, root, node: process.version,
  platform: process.platform, scope: 'Each sample is a fresh Node process. firstBodyReadySinceProcessStartMs is captured before hashing/verification; parent processElapsedMs additionally includes spawn/verification/exit. OS file cache is not flushed. No network or browser.',
  snapshot: { hash: info.hash, bytes: info.bytes, performances: info.count }, route,
  source: { before: sourceBefore, afterHash: sourceAfter.hash, stable: sourceBefore.hash === sourceAfter.hash },
  summary: { process: statistics(raw.map(row => row.processElapsedMs)), firstBodyReady: statistics(raw.map(row => row.firstBodyReadySinceProcessStartMs)),
    import: statistics(raw.map(row => row.importMs)), firstResponse: statistics(raw.map(row => row.firstResponseMs)) }, raw };
await saveJson(args.out, report);
if (!report.source.stable) throw new Error('Source changed during startup measurements; report is not an acceptance run');
console.log(JSON.stringify({ out: args.out, ...report.summary, modules: raw[0].modulesAfterResponse }, null, 2));
}
