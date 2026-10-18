import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argumentsOf, coreRoutes, saveJson, semanticHash, snapshotInfo, sourceFingerprint, statistics, workspace } from './common.js';
import { childStopper } from './child-lifecycle.js';

const args = argumentsOf();
if (!args.baseline || !args.out) throw new Error('--baseline and --out are required');
const variants = [{ name: 'baseline', root: resolve(args.baseline) }, { name: 'candidate', root: resolve(args.root ?? workspace) }];
const samples = Number(args.samples ?? '100'), warmup = Number(args.warmup ?? '5');
if (!Number.isInteger(samples) || samples < 1 || samples > 1000 || !Number.isInteger(warmup) || warmup < 0 || warmup > 100) throw new Error('Invalid sample counts');
const info = await snapshotInfo(variants[0].root, args.snapshot);
if ((await snapshotInfo(variants[1].root, args.snapshot)).hash !== info.hash) throw new Error('Different snapshot corpora');
const selected = (args.routes ?? 'national-search,regional-search,national-map,regional-map').split(',');
const routes = coreRoutes(info.snapshot).filter(route => selected.includes(route.name));
if (routes.length !== selected.length) throw new Error('Unknown or repeated route name');
const modes = (args.modes ?? 'miss,hit').split(',');
if (modes.some(mode => !['miss', 'hit'].includes(mode))) throw new Error('Invalid cache mode');
const before = await Promise.all(variants.map(variant => sourceFingerprint(variant.root, ['server', 'shared'])));

async function worker(root: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./api-worker.ts', import.meta.url)), '--root', root, ...(args.snapshot ? ['--snapshot', args.snapshot] : [])],
    { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: process.env });
  let stderr = '', serial = 0, awaiting: { id: number; resolve: (value: any) => void; reject: (error: Error) => void } | undefined;
  child.stdout!.resume(); child.stderr!.setEncoding('utf8').on('data', text => { stderr = (stderr + text).slice(-8000); });
  const stop = childStopper(child);
  try {
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => { void stop().then(() => reject(new Error(`API worker readiness timeout: ${stderr}`)), reject); }, 30_000);
      child.on('message', (message: any) => {
        if (message.type === 'api-worker-ready') {
          clearTimeout(timer); message.snapshotHash === info.hash ? done() : reject(new Error('Worker snapshot differs'));
        }
        else if (awaiting && awaiting.id === message.id) { const current = awaiting; awaiting = undefined; message.error ? current.reject(new Error(message.error)) : current.resolve(message.result); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); awaiting?.reject(error); });
      child.once('close', code => { clearTimeout(timer); const error = new Error(`API worker closed ${code}: ${stderr}`); reject(error); awaiting?.reject(error); });
    });
  } catch (error) { await stop(); throw error; }
  return { stop, async read(route: string, mode: string) {
    if (awaiting) throw new Error('Overlapping API worker operations');
    return new Promise<any>((resolveResult, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => { awaiting = undefined; void stop().then(() => reject(new Error('API worker response timeout')), reject); }, 30_000);
      awaiting = { id, resolve: value => { clearTimeout(timer); resolveResult(value); }, reject: error => { clearTimeout(timer); reject(error); } };
      child.send({ id, route, mode }, error => { if (error && awaiting && awaiting.id === id) { const current = awaiting; awaiting = undefined; current.reject(error); } });
    });
  } };
}

const workers: Awaited<ReturnType<typeof worker>>[] = [], raw: any[] = [];
const summarize = (rows: any[]) => variants.flatMap(variant => routes.flatMap(route => modes.map(mode => {
  const matching = rows.filter(row => row.variant === variant.name && row.name === route.name && row.mode === mode);
  return { variant: variant.name, name: route.name, mode, ...(matching.length ? { ...statistics(matching.map(row => row.elapsedMs)),
    cpu: statistics(matching.map(row => (row.cpuMicros.user + row.cpuMicros.system) / 1000)) } : { samples: 0 }) };
})));
try {
  for (const variant of variants) workers.push(await worker(variant.root));
  for (const route of routes) {
    for (const process of workers) await process.read(route.route, 'miss');
    for (const mode of modes) {
      for (let index = 0; index < warmup; index++) for (const process of workers) await process.read(route.route, mode);
      for (let index = 0; index < samples; index++) {
        const order = index % 2 === 0 ? [0, 1] : [1, 0];
        for (const variantIndex of order) raw.push({ variant: variants[variantIndex].name, name: route.name, index, measuredAt: new Date().toISOString(),
          ...await workers[variantIndex].read(route.route, mode) });
      }
      await saveJson(args.out + '.partial.json', { complete: false, lastCompleted: { route: route.name, mode }, summary: summarize(raw), raw });
      console.log(JSON.stringify({ route: route.name, mode, pairs: samples }));
    }
  }
} catch (error) { await saveJson(args.out + '.failure.json', { error: String(error), raw }); throw error; }
finally { await Promise.all(workers.map(process => process.stop())); }
const after = await Promise.all(variants.map(variant => sourceFingerprint(variant.root, ['server', 'shared'])));
const equality = routes.map(route => {
  const rows = raw.filter(row => row.name === route.name);
  const bodyEqual = new Set(rows.map(row => row.semanticHash)).size === 1;
  const headersEqual = new Set(rows.map(row => semanticHash(Object.fromEntries(Object.entries(row.headers).filter(([name]) => !['date', 'content-length'].includes(name)))))).size === 1;
  const metadataEqual = new Set(rows.map(row => semanticHash(row.metadata))).size === 1;
  return { name: route.name, equal: bodyEqual && headersEqual && metadataEqual, bodyEqual, headersEqual, metadataEqual };
});
const report = { version: 1, measuredAt: new Date().toISOString(), variants, samples, warmup, modes, routes, node: process.version,
  ambientEvidence: args['ambient-evidence'] ?? null,
  limitations: ['Agent workloads are coordinated; external application load is not controlled. Interpret tail latency with the supplied ambient evidence and time blocks.',
    'Windows process CPU samples can be coarse (observed zeros and15/16 ms increments); short-operation CPU/wall ratios are not reliable.'],
  snapshot: { hash: info.hash, performances: info.count, bytes: info.bytes },
  scope: 'Two prepared isolated worker processes; sequential AB/BA pairs, never overlapping requests. Timed handler plus body read only. Miss clears completed values/bytes and asserts one producer; hit asserts zero. Wire SHA is checked every operation; canonical semantics are reused only for identical wire SHA. Three chronological blocks report drift. No network.',
  source: variants.map((variant, index) => ({ variant: variant.name, before: before[index], afterHash: after[index].hash, stable: before[index].hash === after[index].hash })),
  equality, summary: summarize(raw), timeBlocks: [0, 1, 2].map(block => ({ block: block + 1, summary: summarize(raw.filter(row => Math.floor(row.index * 3 / samples) === block)) })), raw };
await saveJson(args.out, report);
console.log(JSON.stringify({ out: args.out, equality, summary: report.summary }, null, 2));
if (equality.some(row => !row.equal) || report.source.some(row => !row.stable)) throw new Error('Semantic mismatch or source instability invalidates API comparison');
