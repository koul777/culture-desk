import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argumentsOf, saveJson, semanticHash, workspace } from './common.js';

const args = argumentsOf();
if (!args.baseline || !args.out) throw new Error('--baseline and --out are required');
const roots = [resolve(args.baseline), resolve(args.root ?? workspace)];
const dataDirectory = resolve(args.data ?? `data/performance-session-20261019/${basename(args.out, '.json')}-payloads`);
await mkdir(dataDirectory, { recursive: true });
const reports: any[] = [];
for (const [index, root] of roots.entries()) {
  const out = resolve(dataDirectory, `${index === 0 ? 'baseline' : 'candidate'}.json`);
  await new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./semantic-child.ts', import.meta.url)), '--root', root, '--out', out, ...(args.snapshot ? ['--snapshot', args.snapshot] : [])],
      { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stderr = '';
    child.stdout.resume(); child.stderr.setEncoding('utf8').on('data', text => { stderr = (stderr + text).slice(-8000); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Semantic child exceeded 120 seconds')); }, 120_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? done() : reject(new Error(`Semantic child failed ${code}: ${stderr}`)); });
  });
  reports.push(JSON.parse(await readFile(out, 'utf8')));
}
function differences(a: any, b: any, path = '$', output: any[] = []): any[] {
  if (output.length >= 30 || Object.is(a, b)) return output;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[key], b[key], `${path}.${key}`, output);
  } else output.push({ path, baseline: a, candidate: b });
  return output;
}
if (reports[0].snapshot.hash !== reports[1].snapshot.hash) throw new Error('Snapshot corpus differs');
const rows = reports[0].raw.map((a: any, index: number) => {
  const b = reports[1].raw[index];
  const left = { name: a.name, route: a.route, method: a.method, status: a.status, headers: a.headers, payload: a.payload };
  const right = { name: b.name, route: b.route, method: b.method, status: b.status, headers: b.headers, payload: b.payload };
  return { name: a.name, route: a.route, method: a.method, status: a.status, equal: semanticHash(left) === semanticHash(right),
    baselineHash: a.semanticHash, candidateHash: b.semanticHash, baselineBytes: a.bytes, candidateBytes: b.bytes, differences: differences(left, right) };
});
const report = { version: 1, measuredAt: new Date().toISOString(), snapshot: reports[0].snapshot, cases: rows.length,
  equal: rows.every((row: any) => row.equal), source: reports.map(value => value.source), rawDirectory: dataDirectory,
  normalization: 'JSON preserves all fields including snapshotAt, sourceCounts, pendingDetails, partial, truncation and order. Excel compares every cell value/style/format, sheet dimensions/views/filter, creator; only B2 extraction time and workbook created timestamp are per-read times. ZIP bytes and transport Date/Content-Length are not semantic equality gates.', rows };
await saveJson(args.out, report);
console.log(JSON.stringify({ out: args.out, equal: report.equal, cases: report.cases, mismatches: rows.filter((row: any) => !row.equal).map((row: any) => ({ name: row.name, differences: row.differences })) }, null, 2));
if (!report.equal) process.exitCode = 1;
