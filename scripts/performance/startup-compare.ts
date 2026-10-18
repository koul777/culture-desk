import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argumentsOf, coreRoutes, saveJson, snapshotInfo, sourceFingerprint, statistics, workspace } from './common.js';
import { runJsonChild } from './child-process.js';

export async function compareStartup(args: Record<string, string>) {
if (!args.baseline || !args.out) throw new Error('--baseline and --out are required');
const variants = [{ name: 'baseline', root: resolve(args.baseline) }, { name: 'candidate', root: resolve(args.root ?? workspace) }];
const samples = Number(args.samples ?? '50'), warmup = Number(args.warmup ?? '2');
if (!Number.isInteger(samples) || samples < 1 || samples > 200 || !Number.isInteger(warmup) || warmup < 0 || warmup > 10) throw new Error('Invalid sample counts');
const info = await snapshotInfo(variants[0].root);
if ((await snapshotInfo(variants[1].root)).hash !== info.hash) throw new Error('Different snapshot corpora');
const route = args.route ?? coreRoutes(info.snapshot)[1].route;
const before = await Promise.all(variants.map(variant => sourceFingerprint(variant.root, ['server', 'shared'])));
const child = fileURLToPath(new URL('./startup-child.ts', import.meta.url));
const raw: any[] = [], discarded: any[] = [];
const summary = () => variants.map(variant => {
  const rows = raw.filter(row => row.variant === variant.name);
  return { variant: variant.name, samples: rows.length, ...(rows.length ? {
    firstBodyReady: statistics(rows.map(row => row.firstBodyReadySinceProcessStartMs)), import: statistics(rows.map(row => row.importMs)),
    firstResponse: statistics(rows.map(row => row.firstResponseMs)), processElapsed: statistics(rows.map(row => row.processElapsedMs)),
  } : {}) };
});
const timeBlocks = () => [0, 1, 2].map(block => ({ block: block + 1, variants: variants.map(variant => {
  const rows = raw.filter(row => row.variant === variant.name && Math.floor(row.round * 3 / samples) === block);
  return { variant: variant.name, firstRound: rows[0]?.round, lastRound: rows.at(-1)?.round,
    ...(rows.length ? { firstBodyReady: statistics(rows.map(row => row.firstBodyReadySinceProcessStartMs)),
      import: statistics(rows.map(row => row.importMs)), firstResponse: statistics(rows.map(row => row.firstResponseMs)) } : {}) };
}) }));
try {
  for (let round = -warmup; round < samples; round++) {
    // AB / BA pairs balance temporal order. Warmup processes are fresh but discarded.
    const order = Math.abs(round) % 2 === 0 ? variants : [...variants].reverse();
    for (const variant of order) {
      const result = await runJsonChild(child, ['--root', variant.root, '--route', route], 'startup-result');
      const row = { variant: variant.name, round, measuredAt: new Date().toISOString(), ...result };
      (round < 0 ? discarded : raw).push(row);
    }
    if (round >= 0 && (round + 1) % 10 === 0) {
      await saveJson(args.out + '.partial.json', { completedPairs: round + 1, summary: summary(), raw });
      console.log(JSON.stringify({ completedPairs: round + 1, totalPairs: samples }));
    }
  }
} catch (error) { await saveJson(args.out + '.failure.json', { error: String(error), variants, route, raw, discarded }); throw error; }
const after = await Promise.all(variants.map(variant => sourceFingerprint(variant.root, ['server', 'shared'])));
const equal = new Set(raw.map(row => row.semanticHash)).size === 1;
const report = { version: 1, measuredAt: new Date().toISOString(), variants, samples, warmup, route, node: process.version,
  scope: 'Each sample runs a new Node process; AB/BA paired ordering, warmup processes discarded. Primary firstBodyReady is child performance.now before payload verification. OS filesystem cache is warm and not flushed. No network. Exact semantic hash equality is mandatory.',
  snapshot: { hash: info.hash, performances: info.count, bytes: info.bytes },
  source: variants.map((variant, index) => ({ variant: variant.name, before: before[index], afterHash: after[index].hash, stable: before[index].hash === after[index].hash })),
  equal, summary: summary(), timeBlocks: timeBlocks(), discarded, raw };
await saveJson(args.out, report);
console.log(JSON.stringify({ out: args.out, equal, summary: report.summary }, null, 2));
if (!equal || report.source.some(row => !row.stable)) throw new Error('Semantic mismatch or source instability invalidates startup comparison');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await compareStartup(argumentsOf());
