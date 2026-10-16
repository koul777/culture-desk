import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parse } from 'dotenv';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig, ROOT } from '../server/config.js';
import { Store } from '../server/store.js';
import { NATIONAL_CITIES } from '../server/providers/cities.js';
import { createProviders } from '../server/providers/index.js';
import { decodeSnapshot, getSnapshotRepository } from '../server/cloud/snapshot.js';
import { auditRefreshCheckpoint, getRefreshJobRepository, refreshWindow, safeRefreshError, LeaseLostError } from '../server/cloud/refresh-jobs.js';
import { importCollection } from '../server/import-collection.js';

// Runtime secrets win; ignored local files are only a convenience for operator verification.
for (const filename of ['.env', '.env.vercel']) if (existsSync(path.join(ROOT, filename))) {
  const values = parse(readFileSync(path.join(ROOT, filename)));
  for (const name of ['DATABASE_URL', 'POSTGRES_URL', 'KOPIS_API_KEY', 'CULTURE_API_KEY']) if (!process.env[name] && values[name]) process.env[name] = values[name];
}
const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...data }));
const jobs = getRefreshJobRepository();
const window = refreshWindow();
const args = process.argv.slice(2);
let child: ChildProcess | undefined;
let leaseLost = false;
let interrupted = false;
let stoppingAt = 0;
let owned: { day: string; owner: string } | undefined;
let stopFile: string | undefined;
const stop = () => {
  interrupted = true;
  if (!stoppingAt) stoppingAt = Date.now();
  if (stopFile) writeFileSync(stopFile, 'scheduled runner stop');
};
process.on('SIGINT', stop); process.on('SIGTERM', stop);

async function main() {
  const config = readConfig(path.join(ROOT, '.scheduled-runtime-env-does-not-exist'));
  if (!config.keys.kopis || !config.keys.culture) throw Object.assign(new Error('Missing provider credentials'), { kind: 'auth' });
  if (args.includes('--probe')) {
    const providers = createProviders(config.keys, { timeoutMs: 30000 });
    for (const source of ['kopis', 'culture'] as const) {
      const result = await providers[source]!.list({ city: NATIONAL_CITIES.find(city => city.id === 'andong') || NATIONAL_CITIES[0], from: window.day, to: window.day, page: 1, pageSize: 1 });
      log('provider_probe', { source, ok: true, returned: result.items.length });
    }
    await jobs.probe();
    log('refresh_probe', { database: 'read_write_lease_ok', status: await jobs.publicStatus() });
    return;
  }
  const seedIndex = args.indexOf('--seed-checkpoint');
  if (seedIndex >= 0) {
    const filename = args[seedIndex + 1]; if (!filename) throw new Error('Missing seed checkpoint');
    const db = new DatabaseSync(path.resolve(filename), { readOnly: true });
    try {
      const audit = auditRefreshCheckpoint(db, window);
      if (!audit.complete) throw new Error('Seed checkpoint does not completely cover today\'s nationwide range');
      log('seed_complete', { inserted: await jobs.seed(window, readFileSync(filename), audit.counts), day: window.day, counts: audit.counts });
    } finally { db.close(); }
    return;
  }
  const owner = randomUUID();
  const claim = await jobs.acquire(window, owner);
  if (claim.state !== 'acquired') { log('refresh_skip', { reason: claim.state, day: window.day }); return; }
  const job = claim.job;
  owned = { day: job.day, owner };
  const batch = `scheduled-${job.day.replaceAll('-', '')}`;
  // A stale child can outlive its lease. Never share its SQLite files or remove its lock.
  const directory = path.join(ROOT, 'data', 'scheduled', batch, owner);
  mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, 'collection.db');
  stopFile = path.join(directory, 'stop.request');
  if (existsSync(stopFile)) unlinkSync(stopFile);
  // Only this leased job's durable checkpoint is authoritative.
  if (job.checkpoint) writeFileSync(filename, decodeSnapshot(job.checkpoint));
  const store = new Store(filename, NATIONAL_CITIES);
  try {
    for (const row of store.db.prepare("SELECT id FROM sync_runs WHERE state!='complete'").all()) store.setRunState(Number(row.id), 'queued');
  } finally { store.close(); }
  const heartbeat = setInterval(() => {
    void jobs.heartbeat(job.day, owner).catch(() => { leaseLost = true; stop(); });
  }, 30000);
  const rawBudget = Number(process.env.NATIONAL_RUN_BUDGET_MINUTES || 50);
  const budget = Math.max(45, Math.min(55, Number.isFinite(rawBudget) ? rawBudget : 50)) * 60000;
  const started = Date.now();
  let lastSave = 0;
  let lastCheckpoint: string | undefined;
  const progressFile = path.join(directory, 'progress.json');
  // Delete a stale report so a fresh runner cannot publish another day's previous file.
  if (existsSync(progressFile)) unlinkSync(progressFile);
  const env = { ...process.env, NATIONAL_FROM: job.from, NATIONAL_TO: job.to, NATIONAL_BATCH: batch, NATIONAL_DIRECTORY: directory };
  let exited = false, exitCode: number | null = null;
  child = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'scripts', 'collect-national.ts')], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'ignore'] });
  child.once('error', () => { exited = true; exitCode = 1; });
  child.once('exit', code => { exited = true; exitCode = code; });
  const publish = async (checkpoint: string) => {
    if (leaseLost) throw new LeaseLostError();
    const resolved = path.resolve(checkpoint);
    if (path.dirname(resolved) !== directory || !/^checkpoint-\d+\.db$/.test(path.basename(resolved))) throw new Error('Invalid collector checkpoint path');
    const source = new DatabaseSync(resolved, { readOnly: true });
    try {
      const audit = auditRefreshCheckpoint(source, job);
      await jobs.heartbeat(job.day, owner);
      await jobs.save(job.day, owner, readFileSync(resolved), audit.counts);
      // Completion is only recorded after the production merge succeeds.
      await getSnapshotRepository().withStore(true, async target => {
        await jobs.heartbeat(job.day, owner);
        return importCollection(source, target, batch);
      });
      lastCheckpoint = checkpoint; lastSave = Date.now();
      log('refresh_checkpoint', { day: job.day, counts: audit.counts, complete: audit.complete });
      return audit;
    } finally { source.close(); }
  };
  try {
    while (!exited) {
      if (!interrupted && Date.now() - started >= budget) stop();
      if (stoppingAt && Date.now() - stoppingAt > 60000) child.kill('SIGKILL');
      if (leaseLost) { child.kill('SIGTERM'); throw new LeaseLostError(); }
      if (Date.now() - lastSave >= 120000 && existsSync(progressFile)) {
        const progress = JSON.parse(readFileSync(progressFile, 'utf8'));
        if (progress.from !== job.from || progress.to !== job.to || progress.batch !== batch) throw new Error('Collector range mismatch');
        if (progress.checkpoint && progress.checkpoint !== lastCheckpoint) await publish(progress.checkpoint);
      }
      await delay(1000);
    }
    if (leaseLost) throw new LeaseLostError();
    let complete = false;
    if (existsSync(progressFile)) {
      const progress = JSON.parse(readFileSync(progressFile, 'utf8'));
      if (progress.from !== job.from || progress.to !== job.to || progress.batch !== batch) throw new Error('Collector range mismatch');
      if (progress.checkpoint) complete = (await publish(progress.checkpoint)).complete;
    }
    await jobs.finish(job.day, owner, complete);
    owned = undefined;
    log(complete ? 'refresh_complete' : 'refresh_retry_wait', { day: job.day, childExit: exitCode, interrupted });
    if (!complete) process.exitCode = 2;
  } finally { clearInterval(heartbeat); }
}
try { await main(); }
catch (error) {
  stop(); child?.kill('SIGTERM');
  if (owned && !leaseLost) await jobs.finish(owned.day, owned.owner, false, error).catch(() => {});
  log('refresh_error', { message: safeRefreshError(error) });
  process.exitCode = 1;
}
