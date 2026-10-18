import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT } from '../server/config.js';
import { Store } from '../server/store.js';
import { NATIONAL_CITIES } from '../server/providers/cities.js';
import { importCollection } from '../server/import-collection.js';
import { archiveCompletedCollectionRuns } from '../server/collection-history.js';
import { auditRefreshCheckpoint, refreshWindow, type RefreshWindow } from '../server/cloud/refresh-jobs.js';
import { insertPublicSnapshot, readPublicSnapshot, type PublishedRefresh } from '../server/cloud/readonly-fallback.js';
import { buildPublicFallback } from './build-public-fallback.js';
import { copyFileAtomic, inspectSnapshot, sameCollection, writeJsonAtomic } from './release-state.js';

/**
 * Scheduled refresh without a database service. GitHub Actions restores `stateDirectory` from the
 * previous run's artifact, this script collects into it and rewrites the public snapshot, and the
 * workflow uploads the directory again and deploys the snapshot to Vercel.
 */
export interface CollectResult { exitCode: number | null }
export type Collect = (window: RefreshWindow, directory: string, batch: string) => Promise<CollectResult>;
export interface DailyPublishOptions {
  stateDirectory: string;
  snapshotPath: string;
  collect: Collect;
  window?: RefreshWindow;
  now?: () => Date;
}
const INCOMPLETE = '일부 요청을 완료하지 못했습니다. 저장한 지점부터 다음 예약에서 이어서 수집합니다.';
const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...data }));

function readState(file: string): PublishedRefresh | undefined {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as PublishedRefresh : undefined; } catch { return undefined; }
}

/** The first run, or one whose state artifact expired, continues from the committed public rows. */
async function seedProduction(file: string, snapshotPath: string): Promise<string | null> {
  const store = new Store(file, NATIONAL_CITIES);
  try {
    if (!existsSync(snapshotPath)) return null;
    const snapshot = await readPublicSnapshot(snapshotPath);
    insertPublicSnapshot(store, snapshot);
    return snapshot.refresh?.lastSuccessAt ?? null;
  } finally { store.close(); }
}

export async function runDailyPublish(options: DailyPublishOptions) {
  const now = options.now ?? (() => new Date());
  const window = options.window ?? refreshWindow(now());
  const stateFile = path.join(options.stateDirectory, 'job.json');
  const production = path.join(options.stateDirectory, 'production.db');
  const directory = path.join(options.stateDirectory, 'collect');
  mkdirSync(options.stateDirectory, { recursive: true });
  const previous = readState(stateFile);
  const savedSnapshot = path.join(options.stateDirectory, 'public-snapshot.json');
  if (previous?.day === window.day && previous.status === 'complete') {
    let saved;
    try { saved = inspectSnapshot(savedSnapshot); } catch { /* Rebuild a missing or invalid saved export from the database. */ }
    if (sameCollection(previous, saved?.refresh)) {
      copyFileAtomic(savedSnapshot, options.snapshotPath);
      return { skipped: 'complete' as const, state: previous };
    }
    if (existsSync(production)) {
      buildPublicFallback({ input: production, output: options.snapshotPath, snapshotAt: previous.updatedAt ?? now().toISOString(), refresh: previous });
      copyFileAtomic(options.snapshotPath, savedSnapshot);
      return { skipped: 'complete' as const, state: previous };
    }
  }
  let lastSuccessAt = previous?.lastSuccessAt ?? null;
  if (!existsSync(production)) {
    let seedSnapshot = options.snapshotPath;
    try { if (inspectSnapshot(savedSnapshot)) seedSnapshot = savedSnapshot; } catch { /* Fall back to the committed snapshot if the saved file is damaged. */ }
    lastSuccessAt = (await seedProduction(production, seedSnapshot)) ?? lastSuccessAt;
  }
  // A previous day's partial collection is superseded by today's full range.
  if (previous?.day !== window.day) rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  // Persist the window before starting. A collector/export crash must resume this day's checkpoint.
  writeJsonAtomic(stateFile, { status: 'retry_wait', day: window.day, from: window.from, to: window.to,
    counts: previous?.day === window.day ? previous.counts : null, lastSuccessAt, updatedAt: now().toISOString(), error: INCOMPLETE } satisfies PublishedRefresh);
  for (const name of ['stop.request', 'progress.json', 'collection.db.lock']) rmSync(path.join(directory, name), { force: true });
  const collection = path.join(directory, 'collection.db');
  if (existsSync(collection)) {
    const store = new Store(collection, NATIONAL_CITIES);
    try { for (const row of store.db.prepare("SELECT id FROM sync_runs WHERE state!='complete'").all()) store.setRunState(Number(row.id), 'queued'); }
    finally { store.close(); }
  }
  const batch = `scheduled-${window.day.replaceAll('-', '')}`;
  const { exitCode } = await options.collect(window, directory, batch);
  for (const name of readdirSync(directory)) if (/^checkpoint-\d+\.db$/.test(name)) unlinkSync(path.join(directory, name));

  let complete = false;
  let counts: PublishedRefresh['counts'] = null;
  if (existsSync(collection)) {
    // Opening read-write first recovers a WAL left by an interrupted collector.
    const collected = new Store(collection, NATIONAL_CITIES);
    const target = new Store(production, NATIONAL_CITIES);
    try {
      const audit = auditRefreshCheckpoint(collected.db, window);
      importCollection(collected.db, target, batch);
      if (audit.complete) archiveCompletedCollectionRuns(target);
      ({ complete, counts } = audit);
    } finally { collected.close(); target.close(); }
  }
  const at = now().toISOString();
  if (complete) lastSuccessAt = at;
  const state: PublishedRefresh = { status: complete ? 'complete' : 'retry_wait', day: window.day, from: window.from, to: window.to,
    counts, lastSuccessAt, updatedAt: at, error: complete ? null : INCOMPLETE };
  const published = buildPublicFallback({ input: production, output: options.snapshotPath, snapshotAt: at, refresh: state });
  // A complete collection is acknowledged only after its validated export is durable.
  // Deployment acknowledgement is separate and written by the workflow after Vercel succeeds.
  copyFileAtomic(options.snapshotPath, savedSnapshot);
  writeJsonAtomic(stateFile, state);
  if (complete) rmSync(directory, { recursive: true, force: true });
  return { state, collectorExit: exitCode, published };
}

/** Runs the existing resumable collector within the job budget; it saves progress when asked to stop. */
export function spawnCollector(budgetMs: number): Collect {
  return async (window, directory, batch) => {
    const env = { ...process.env, NATIONAL_FROM: window.from, NATIONAL_TO: window.to, NATIONAL_BATCH: batch, NATIONAL_DIRECTORY: directory };
    // Provider errors can contain request URLs, so the collector's own output is not forwarded.
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'scripts', 'collect-national.ts')], { cwd: ROOT, env, stdio: 'ignore' });
    let exitCode: number | null = null, exited = false, stoppingAt = 0, lastLog = 0;
    child.once('error', () => { exited = true; exitCode = 1; });
    child.once('exit', code => { exited = true; exitCode = code; });
    const stop = () => { if (!stoppingAt) { stoppingAt = Date.now(); writeFileSync(path.join(directory, 'stop.request'), 'budget'); } };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    const started = Date.now();
    while (!exited) {
      if (Date.now() - started >= budgetMs) stop();
      if (stoppingAt && Date.now() - stoppingAt > 60000) child.kill('SIGKILL');
      if (Date.now() - lastLog >= 300000) {
        lastLog = Date.now();
        try { const { tasks } = JSON.parse(readFileSync(path.join(directory, 'progress.json'), 'utf8')); log('collect_progress', { tasks }); } catch {}
      }
      await delay(1000);
    }
    return { exitCode };
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const rawBudget = Number(process.env.NATIONAL_RUN_BUDGET_MINUTES || 50);
  const budget = Math.max(5, Math.min(55, Number.isFinite(rawBudget) ? rawBudget : 50)) * 60000;
  try {
    const result = await runDailyPublish({
      stateDirectory: path.resolve(process.env.DAILY_STATE_DIRECTORY || path.join(ROOT, 'data', 'daily')),
      snapshotPath: path.join(ROOT, 'server', 'assets', 'public-snapshot.json'),
      collect: spawnCollector(budget),
    });
    if ('skipped' in result) log('refresh_skip', { reason: 'already_complete', day: result.state.day });
    else log(result.state.status === 'complete' ? 'refresh_complete' : 'refresh_retry_wait', { day: result.state.day, counts: result.state.counts,
      collectorExit: result.collectorExit, publicPerformances: result.published.publicPerformances, coveredPairs: result.published.coveredPairs });
  } catch (error) {
    log('refresh_error', { name: (error as Error)?.name || 'Error' });
    process.exitCode = 1;
  }
}
