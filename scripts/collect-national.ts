import { existsSync, mkdirSync, writeFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../server/config.js';
import { Store, type Task } from '../server/store.js';
import { Worker } from '../server/worker.js';
import { acquireLock } from '../server/lock.js';
import { NATIONAL_CITIES } from '../server/providers/cities.js';
import { createProviders } from '../server/providers/index.js';
import type { FetchFn } from '../server/providers/fetch.js';
import type { Source } from '../shared/types.js';
import { readNationalBatch } from './national-config.js';

// Independent, resumable collection. Never opens or replaces the application database.
// Existing completed runs remain complete on resume; no automatic refresh is scheduled.
const { from, to, batch, directory, filename } = readNationalBatch();
mkdirSync(directory, { recursive: true });
const reportFile = path.join(directory, 'progress.json');
const stopFile = path.join(directory, 'stop.request');
if (existsSync(stopFile)) throw new Error('Remove the collection stop.request file before resuming.');
const releaseLock = acquireLock(filename);
const config = { ...readConfig(), databasePath: filename, syncIntervalHours: 720 };
const sources: Source[] = ['kopis', 'culture'];
if (sources.some(source => !config.keys[source])) {
  releaseLock();
  throw new Error('Both provider keys are required; no credentials are logged.');
}

type Gate = { tail: Promise<void>; active: number; next: number; started: number; completed: number; failures: number; httpFailures: number };
const gates: Record<Source, Gate> = {
  kopis: { tail: Promise.resolve(), active: 0, next: 0, started: 0, completed: 0, failures: 0, httpFailures: 0 },
  culture: { tail: Promise.resolve(), active: 0, next: 0, started: 0, completed: 0, failures: 0, httpFailures: 0 },
};
const limitedFetch: FetchFn = async (url, init) => {
  const source = new URL(url).hostname.endsWith('kopis.or.kr') ? 'kopis' : 'culture';
  const gate = gates[source];
  const enter = gate.tail.then(async () => {
    while (gate.active >= 4 || Date.now() < gate.next) {
      init?.signal?.throwIfAborted();
      await delay(Math.min(200, Math.max(20, gate.next - Date.now())));
    }
    init?.signal?.throwIfAborted();
    gate.active++;
    gate.next = Date.now() + 350;
    gate.started++;
  });
  gate.tail = enter.catch(() => {});
  await enter;
  try {
    const response = await fetch(url, init);
    // Keep the concurrency permit until the body is downloaded, as providers parse XML afterwards.
    const body = await response.arrayBuffer();
    gate.completed++;
    if (!response.ok) gate.httpFailures++;
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    gate.failures++;
    throw error;
  } finally { gate.active--; }
};

class BatchWorker extends Worker { override refreshDue() {} }
const store = new Store(filename, NATIONAL_CITIES);
const providers = createProviders(config.keys, { fetch: limitedFetch, timeoutMs: 30000 });
// Each source owns four workers so one long queue cannot block the other API.
// All other Store methods are bound to the one owner; no constructor or recovery runs twice.
function sourceStore(source: Source): Store {
  const select = store.db.prepare(`SELECT t.* FROM sync_tasks t JOIN sync_runs r ON r.id=t.run_id
    WHERE t.source=? AND t.state='queued' AND t.available_at<=? AND r.state IN ('queued','running')
    ORDER BY CASE WHEN t.kind='list' THEN 0 ELSE 1 END,t.id LIMIT 1`);
  const nextTask = (): Task | undefined => store.transaction(() => {
    const row = select.get(source, new Date().toISOString()) as unknown as Task | undefined;
    if (!row) return undefined;
    store.db.prepare("UPDATE sync_tasks SET state='running',attempts=attempts+1 WHERE id=?").run(row.id);
    store.db.prepare("UPDATE sync_runs SET state='running',updated_at=? WHERE id=?").run(new Date().toISOString(), row.run_id);
    return { ...row, attempts: Number(row.attempts) + 1 };
  });
  return new Proxy(store, { get(target, key) {
    if (key === 'nextTask') return nextTask;
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
const workers = sources.flatMap(source => {
  const scoped = sourceStore(source);
  return Array.from({ length: 4 }, () => new BatchWorker(scoped, config, providers));
});
const startedAt = new Date().toISOString();
let stopping = false;
let checkpoint: string | null = null;
let lastCheckpoint = 0;
let fatal = false;
const pending = store.db.prepare("SELECT 1 FROM sync_tasks t JOIN sync_runs r ON r.id=t.run_id WHERE t.state IN ('queued','running') AND r.state IN ('queued','running') LIMIT 1");

store.transaction(() => {
  const existing = store.db.prepare('SELECT id FROM sync_runs WHERE source=? AND city_id=? AND from_date=? AND to_date=? AND detail_only=0 LIMIT 1');
  for (const city of NATIONAL_CITIES) for (const source of sources) {
    if (!existing.get(source, city.id, from, to)) store.createRun(source, city.id, from, to);
  }
});

function report(final = false) {
  const now = Date.now();
  if (final || now - lastCheckpoint >= 60000) {
    checkpoint = path.join(directory, `checkpoint-${now}.db`);
    store.backup(checkpoint);
    lastCheckpoint = now;
  }
  const coverage = store.db.prepare(`SELECT r.id,r.source,r.city_id,r.state,
    SUM(CASE WHEN t.kind='list' THEN 1 ELSE 0 END) list_total,
    SUM(CASE WHEN t.kind='list' AND t.state='done' THEN 1 ELSE 0 END) list_done,
    SUM(CASE WHEN t.kind='detail' THEN 1 ELSE 0 END) detail_total,
    SUM(CASE WHEN t.kind='detail' AND t.state='done' THEN 1 ELSE 0 END) detail_done,
    SUM(CASE WHEN t.state='failed' THEN 1 ELSE 0 END) failed,
    (SELECT COUNT(*) FROM sync_items i WHERE i.run_id=r.id) records
    FROM sync_runs r LEFT JOIN sync_tasks t ON t.run_id=r.id
    GROUP BY r.id ORDER BY r.city_id,r.source`).all();
  const records = store.db.prepare('SELECT source,classification,detail_state,COUNT(*) count FROM performances GROUP BY source,classification,detail_state').all();
  const runs = store.db.prepare('SELECT source,state,COUNT(*) count FROM sync_runs GROUP BY source,state').all();
  const tasks = store.db.prepare('SELECT source,kind,state,COUNT(*) count FROM sync_tasks GROUP BY source,kind,state').all();
  const requests = Object.fromEntries(sources.map(source => {
    const { started, completed, failures, httpFailures, active } = gates[source];
    return [source, { started, completed, transportFailures: failures, httpFailures, active }];
  }));
  const payload = { batch, from, to, pid: process.pid, startedAt, updatedAt: new Date(now).toISOString(),
    final, interrupted: stopping, fatal, expectedRegions: NATIONAL_CITIES.length,
    expectedRuns: NATIONAL_CITIES.length * sources.length, filename, checkpoint,
    checkpointBytes: checkpoint ? statSync(checkpoint).size : null, runs, tasks, records, requests, coverage };
  writeFileSync(reportFile + '.tmp', JSON.stringify(payload, null, 2), 'utf8');
  renameSync(reportFile + '.tmp', reportFile);
  console.log(JSON.stringify({ event: final ? 'finished' : 'progress', updatedAt: payload.updatedAt, checkpoint,
    checkpointBytes: payload.checkpointBytes, runs, tasks, records, requests }));
}

const stop = () => { stopping = true; for (const worker of workers) void worker.stop(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
report();
const timer = setInterval(() => { try { if (existsSync(stopFile)) stop(); report(); } catch { fatal = true; stop(); } }, 10000);

try {
  await Promise.all(workers.map(async worker => {
    try {
      while (!stopping && pending.get()) {
        await worker.tick();
        await delay(25);
      }
    } catch {
      fatal = true;
      stop();
      process.exitCode = 1;
    }
  }));
} catch {
  fatal = true;
  stop();
  process.exitCode = 1;
} finally {
  clearInterval(timer);
  await Promise.all(workers.map(worker => worker.stop()));
  report(true);
  if (store.db.prepare("SELECT 1 FROM sync_runs WHERE state!='complete' LIMIT 1").get()) process.exitCode = 2;
  store.close();
  releaseLock();
}
