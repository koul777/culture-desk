import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Store } from '../server/store.js';
import { DEFAULT_CITIES } from '../server/providers/cities.js';
import { runCloudCollection } from '../server/cloud/collection.js';
import type { PerformanceInput, Provider } from '../shared/types.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** Serialize the same write boundary as the snapshot row lock, with an isolated in-memory DB. */
function fixture(t: TestContext) {
  const store = new Store(':memory:', DEFAULT_CITIES);
  let tail: Promise<unknown> = Promise.resolve();
  const pending: Promise<unknown>[] = [];
  const releases: (() => void)[] = [];
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('TEST forbids real HTTP'); });
  const repository = {
    withStore<T>(_write: boolean, operation: (value: Store) => Promise<T>): Promise<T> {
      const result = tail.then(() => operation(store));
      tail = result.catch(() => {});
      return result;
    },
  };
  t.after(async () => {
    for (const release of releases) release();
    await Promise.allSettled(pending);
    assert.equal(fetch.mock.callCount(), 0, 'race tests must never call a real provider');
    store.close();
  });
  function tick(provider: Provider, tickStepMs = 12000) {
    const promise = runCloudCollection({ repository, env: { AUTOMATIC_REFRESH_ENABLED: '1' },
      providers: { kopis: provider }, tickBudgetMs: 35000, tickStepMs });
    pending.push(promise);
    return promise;
  }
  return { store, repository, tick, releases };
}

test('a provider resolving successfully after its timeout cannot complete the claimed task', { timeout: 10000 }, async t => {
  const { store, tick, releases } = fixture(t);
  const id = store.createRun('kopis', 'andong', '2026-10-01', '2026-10-31');
  const aborted = deferred(), release = deferred();
  releases.push(() => release.resolve(undefined));
  let calls = 0;
  const provider: Provider = {
    source: 'kopis',
    async list(_request, signal) {
      calls++;
      assert.ok(signal);
      const onAbort = () => aborted.resolve(undefined);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      // Deliberately ignore cancellation, as a cached or non-cooperative transport can do.
      await release.promise;
      signal.removeEventListener('abort', onAbort);
      return { items: [], hasMore: false };
    },
    async detail() { throw new Error('TEST unexpected detail request'); },
  };
  const running = tick(provider, 30);
  // The actual abort event controls ordering; no assertion depends on machine timing.
  await aborted.promise;
  assert.equal(store.db.prepare('SELECT state FROM sync_tasks WHERE run_id=?').get(id)!.state, 'queued');
  release.resolve(undefined);
  const result = await running;
  const task = store.db.prepare('SELECT state,attempts,error FROM sync_tasks WHERE run_id=?').get(id)!;
  assert.equal(calls, 1);
  assert.equal(result.steps, 1);
  assert.equal(result.active, true);
  assert.equal(task.state, 'queued', 'late success must remain retryable, not become done');
  assert.equal(task.attempts, 1, 'a real provider timeout consumes exactly one attempt');
  assert.match(String(task.error), /시간이 초과/);
  assert.notEqual(store.runs(1, [id])[0].state, 'complete');
  assert.equal(store.runs(1, [id])[0].tasksDone, 0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM cloud_task_claims').get()!.n, 0);
});

const item = (): PerformanceInput => ({
  source: 'kopis', sourceId: 'TEST-RACE', title: 'TEST initial', cityId: 'andong',
  startDate: '2026-10-01', endDate: '2026-10-31', genre: '연극', sourceGenre: 'TEST', venue: 'TEST venue',
  address: '', poster: '', sourceUrl: '', price: '', priceType: 'unknown', age: '', runtime: '', cast: '',
  producer: '', organizer: '', contact: '', schedule: '', description: '', status: '',
  detailState: 'pending', classification: 'performance', reviewReason: '', raw: { fixture: 'TEST' },
});

test('pause/resume and lease reclamation prevent an older response from overwriting the successor result', { timeout: 10000 }, async t => {
  const { store, repository, tick, releases } = fixture(t);
  const input = item(), performanceId = store.upsert(input);
  store.bookmark(performanceId, true, 'TEST note preserved');
  const runId = store.createRun('kopis', 'andong', input.startDate, input.endDate, true);
  store.addTask(runId, 'kopis', 'andong', 'detail', input.startDate, input.endDate, 1, input.sourceId);
  const entered = deferred(), releaseOld = deferred();
  releases.push(() => releaseOld.resolve(undefined));
  let oldCalls = 0, newCalls = 0, newOwner = '';
  let oldSignal: AbortSignal | undefined;
  const oldProvider: Provider = {
    source: 'kopis',
    async list() { throw new Error('TEST unexpected list request'); },
    async detail(value, signal) {
      oldSignal = signal;
      oldCalls++; entered.resolve(undefined);
      await releaseOld.promise;
      return { ...value, title: 'TEST stale result', detailState: 'complete' };
    },
  };
  const newProvider: Provider = {
    source: 'kopis',
    async list() { throw new Error('TEST unexpected list request'); },
    async detail(value) {
      newCalls++;
      newOwner = String(store.db.prepare('SELECT owner FROM cloud_collection_lease WHERE id=1').get()!.owner);
      return { ...value, title: 'TEST current result', detailState: 'complete' };
    },
  };
  const older = tick(oldProvider);
  await entered.promise;
  const oldOwner = String(store.db.prepare('SELECT owner FROM cloud_collection_lease WHERE id=1').get()!.owner);
  const reserved = store.db.prepare('SELECT available_at FROM sync_tasks WHERE run_id=?').get(runId)!.available_at;
  await repository.withStore(true, async current => { current.setRunState(runId, 'paused'); });
  await repository.withStore(true, async current => { current.setRunState(runId, 'queued'); });
  assert.notEqual(store.db.prepare('SELECT available_at FROM sync_tasks WHERE run_id=?').get(runId)!.available_at, reserved);

  // Resuming a run does not grant another owner permission while the old lease is live.
  const busy = await tick(newProvider);
  assert.equal(busy.steps, 0);
  assert.equal(newCalls, 0);

  // Represent elapsed lease time directly in this fixture; never wait 90 seconds or alter the clock.
  await repository.withStore(true, async current => {
    current.db.prepare('UPDATE cloud_collection_lease SET expires_at=? WHERE id=1').run(Date.now() - 1);
    current.db.prepare('UPDATE cloud_task_claims SET expires_at=?').run(Date.now() - 1);
  });
  const successor = await tick(newProvider);
  assert.equal(successor.active, false);
  assert.equal(newCalls, 1);
  assert.notEqual(newOwner, oldOwner, 'the successor must possess a newly issued claim');
  assert.equal(store.item(performanceId)!.title, 'TEST current result');
  const accepted = store.item(performanceId);
  const completed = store.runs(1, [runId]);

  // The former owner returns only after the successor has committed fresh details.
  assert.equal(oldSignal?.aborted, false, 'this race must be rejected by claim ownership, not by a timeout');
  releaseOld.resolve(undefined);
  await older;
  assert.equal(oldCalls, 1);
  assert.deepEqual(store.item(performanceId), accepted);
  assert.deepEqual(store.runs(1, [runId]), completed);
  assert.equal(store.item(performanceId)!.note, 'TEST note preserved');
  assert.equal(store.item(performanceId)!.bookmarked, true);
  assert.equal(store.db.prepare('SELECT attempts FROM sync_tasks WHERE run_id=?').get(runId)!.attempts, 1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM cloud_task_claims').get()!.n, 0);
});
