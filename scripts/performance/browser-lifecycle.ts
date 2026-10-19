import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import type { BrowserServer } from '@playwright/test';
import { argumentsOf, clientFingerprint, semanticHash, sha256, snapshotInfo, sourceFingerprint } from './common.js';
import { startLifecycleBrowser, startLifecycleFixture, stopLifecycleBrowser, stopOwnedChild, runLifecycleWorker, type Cleanup } from './browser-lifecycle-runtime.js';
import { deadline } from './poster-runtime.js';

// Explicit --mode soak is required for the later authorized 60-minute run.
// The default and initial validation are exactly three cycles, not a timed soak.
const args = argumentsOf();
assert.ok(args.root && args.manifest && args.out, '--root, --manifest, --out required');
const root = resolve(args.root), output = resolve(args.out), manifest = resolve(args.manifest), mode = args.mode ?? 'smoke';
assert.ok(['smoke', 'soak'].includes(mode));
const wallMinutes = mode === 'smoke' ? 5 : 90;
const workerOutput = output.replace(/\.json$/, '') + '-worker.json';
const samples = output.replace(/\.json$/, '') + '.ndjson';
const script = fileURLToPath(new URL('./browser-lifecycle-worker.ts', import.meta.url));
for (const path of [output, output + '.partial.json', workerOutput, samples]) await access(path).then(() => { throw new Error(`Refusing to replace ${path}`); }, error => {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
});
await mkdir(dirname(output), { recursive: true });
const harnessFingerprint = async () => {
  const names = ['browser-lifecycle.ts', 'browser-lifecycle-worker.ts', 'browser-lifecycle-runtime.ts', 'browser-server.ts', 'common.ts', 'poster-runtime.ts'];
  const files = Object.fromEntries(await Promise.all(names.map(async name => [name, sha256(await readFile(new URL(name, import.meta.url)))])));
  return { files, hash: semanticHash(files) };
};
const before = { source: await sourceFingerprint(root), client: await clientFingerprint(root), harness: await harnessFingerprint() };
const info = await snapshotInfo(root), manifestHash = sha256(await readFile(manifest));
assert.equal(info.count, 5649);
let fixture: Awaited<ReturnType<typeof startLifecycleFixture>> | undefined, server: BrowserServer | undefined, child: ChildProcess | undefined;
let failure: string | undefined, result: any, after: any;
const cleanup: Cleanup[] = [], startedAt = new Date().toISOString();
let interrupted = false;
const onSignal = () => {
  interrupted = true; failure ??= 'Supervisor interrupted';
  // The worker has no browser/fixture children; the parent retains those handles
  // and runs the same owned-process cleanup after this wakes its exit wait.
  try { if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill(); }
  catch (error) { failure += `; signal cleanup: ${error}`; }
};
process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
try {
  fixture = await startLifecycleFixture(root); assert.equal(fixture.ready.snapshotHash, info.hash);
  assert.equal(interrupted, false); server = await startLifecycleBrowser(); assert.equal(interrupted, false);
  const exit = await runLifecycleWorker(script, ['--root', root, '--manifest', manifest, '--out', workerOutput,
    '--samples', samples, '--url', fixture.ready.url, '--mode', mode, '--max-wall-minutes', String(wallMinutes),
    ...(args.control ? ['--control', resolve(args.control)] : [])], server.wsEndpoint(), (wallMinutes + 2) * 60000, value => { child = value; });
  result = JSON.parse(await readFile(workerOutput, 'utf8'));
  assert.equal(exit.code, 0, exit.stderr); assert.equal(result.success, true, result.failure);
} catch (error) { failure = error instanceof Error ? error.stack ?? error.message : String(error); }
finally {
  // Persist failure context before any potentially slow cleanup; only own handles/PIDs are used.
  try { await deadline(writeFile(output + '.partial.json', JSON.stringify({ startedAt, failure, workerOutput, samples, cleanup }, null, 2), { flag: 'wx' }), 'Partial report save', 3000); }
  catch (error) { failure ??= `Partial report failed: ${error}`; }
  if (child) cleanup.push(...await stopOwnedChild(child, 'worker'));
  if (server) cleanup.push(...await stopLifecycleBrowser(server));
  if (fixture) cleanup.push(...await stopOwnedChild(fixture.child, 'fixture'));
  try {
    after = { source: await sourceFingerprint(root), client: await clientFingerprint(root), harness: await harnessFingerprint(),
      snapshot: sha256(await readFile(info.path)), manifest: sha256(await readFile(manifest)) };
    assert.equal(before.source.hash, after.source.hash); assert.equal(before.client.hash, after.client.hash);
    assert.equal(before.harness.hash, after.harness.hash); assert.equal(info.hash, after.snapshot); assert.equal(manifestHash, after.manifest);
    if (!result) { try { result = JSON.parse(await readFile(workerOutput, 'utf8')); } catch {} }
  } catch (error) { failure ??= String(error); }
  const owned = [child, server?.process(), fixture?.child].filter((value): value is ChildProcess => !!value);
  const survivingOwnedPids = owned.filter(value => value.pid && value.exitCode === null && value.signalCode === null).map(value => value.pid);
  if (survivingOwnedPids.length) failure ??= `Owned processes remain: ${survivingOwnedPids.join(',')}`;
  if (cleanup.some(entry => !entry.success)) failure ??= 'A graceful cleanup operation failed; see owned-process recovery evidence';
  try {
    await writeFile(output, JSON.stringify({ version: 1, startedAt, endedAt: new Date().toISOString(), mode, success: !failure, failure,
      scope: 'Client map/popup lifecycle stability with unchanged real 5,649-row API responses, local saved raster replay, normal server cache, natural GC. No latency/peak-memory/no-leak claim.',
      root, before, after, snapshot: { hash: info.hash, rows: info.count, bytes: info.bytes }, manifest: { path: manifest, hash: manifestHash },
      workerOutput, samples, result, cleanup, survivingOwnedPids }, null, 2) + '\n', { flag: 'wx' });
  } finally { process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal); }
}
console.log(JSON.stringify({ out: output, success: !failure, failure, mode, cycles: result?.cycles, activeMs: result?.activeMs }));
if (failure) process.exitCode = 1;
