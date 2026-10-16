import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { City, ListRequest, PerformanceInput, Provider, Source, SyncRequest } from '../shared/types.js';
import type { Config } from '../server/config.js';
import { addDays, dateChunks, isDate } from '../server/dates.js';
import { Store } from '../server/store.js';
import { exportWorkbook } from '../server/export.js';

// Every record in this file is fictional TEST data. No application database,
// .env file, real credentials, provider HTTP request, or listening server is used.
const TEST_CITY: City = {
  id: 'test-city', name: 'TEST 가상 도시', sido: 'TEST 시도', sigungu: 'TEST 시군구',
  kopisSido: '99', kopisSigungu: '9999', aliases: ['TEST 가상 도시'],
};
const TEST_OTHER_CITY: City = { ...TEST_CITY, id: 'test-other-city', name: 'TEST 다른 도시' };
const TEST_SECRET = 'TEST_ONLY_NOT_A_REAL_API_KEY_92017';
const TEST_FROM = '2026-01-01';
const TEST_TO = '2026-01-31';
const JSON_HEADERS = { 'x-culture-request': '1', 'content-type': 'application/json' };
const originalFetch = globalThis.fetch;
let forbiddenFetches = 0;
before(() => {
  globalThis.fetch = async () => {
    forbiddenFetches++;
    throw new Error('TEST: external fetch is prohibited');
  };
});
after(() => {
  globalThis.fetch = originalFetch;
  assert.equal(forbiddenFetches, 0, 'Tests must never attempt external fetch');
});

function performance(sourceId: string, changes: Partial<PerformanceInput> = {}): PerformanceInput {
  return {
    source: 'kopis', sourceId: `TEST-${sourceId}`, title: `TEST 가상 공연 ${sourceId}`,
    cityId: TEST_CITY.id, startDate: '2026-01-10', endDate: '2026-01-12',
    genre: '연극', sourceGenre: 'TEST 연극', venue: 'TEST 가상 공연장', address: '',
    poster: '', sourceUrl: 'https://example.invalid/TEST-performance', price: '',
    priceType: 'unknown', age: '', runtime: '', cast: '', producer: '', organizer: '',
    contact: '', schedule: '', description: '', status: '', detailState: 'pending',
    classification: 'performance', reviewReason: '', raw: { fixture: 'TEST ONLY' }, ...changes,
  };
}

function temporaryStore(t: TestContext) {
  const tempRoot = realpathSync(os.tmpdir());
  const directory = mkdtempSync(path.join(tempRoot, 'culture-core-test-'));
  const filename = path.join(directory, 'test.sqlite');
  let store = new Store(filename, [TEST_CITY, TEST_OTHER_CITY]);
  let open = true;
  const stopHooks: (() => Promise<void>)[] = [];
  t.after(async () => {
    try {
      for (const hook of stopHooks.reverse()) await hook();
    } finally {
      try { if (open) store.close(); } finally {
        // Only the exact directory created above may be recursively removed.
        const resolved = realpathSync(directory);
        assert.equal(path.dirname(resolved), tempRoot);
        assert.ok(path.basename(resolved).startsWith('culture-core-test-'));
        rmSync(resolved, { recursive: true, force: true });
      }
    }
  });
  return {
    get store() { return store; }, filename, stopHooks,
    reopen() {
      store.close(); open = false;
      store = new Store(filename, [TEST_CITY, TEST_OTHER_CITY]); open = true;
      return store;
    },
  };
}

function config(databasePath: string): Config {
  return {
    port: 4317, databasePath, keys: { kopis: TEST_SECRET, culture: '' },
    requestIntervalMs: 60_000, syncIntervalHours: 720,
  };
}

function provider(changes: Partial<Provider> = {}): Provider {
  return {
    source: 'kopis',
    async list() { return { items: [], hasMore: false }; },
    async detail(item) { return { ...item, detailState: 'complete' }; },
    ...changes,
  };
}

async function workerFixture(t: TestContext, injected: Partial<Record<Source, Provider>>) {
  const fixture = temporaryStore(t);
  const { Worker } = await import('../server/worker.js');
  // Freeze only scheduling timers. Explicit tick() calls exercise real Worker
  // logic; retry availability is advanced in this private fixture DB below.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = new Worker(fixture.store, config(fixture.filename), injected);
  worker.start();
  fixture.stopHooks.push(() => worker.stop());
  return { ...fixture, store: fixture.store, worker };
}

async function appFixture(t: TestContext, injected: Partial<Record<Source, Provider>> = {}) {
  const fixture = temporaryStore(t);
  const { createApp } = await import('../server/app.js');
  const { app, worker } = await createApp(config(fixture.filename), {
    store: fixture.store, providers: injected, startWorker: false,
  });
  fixture.stopHooks.push(() => app.close());
  return { ...fixture, store: fixture.store, app, worker };
}

function enqueue(worker: { enqueue: (request: SyncRequest) => { runs: { id: number }[] } }, cities = [TEST_CITY.id]) {
  return worker.enqueue({ cities, sources: ['kopis'], from: TEST_FROM, to: TEST_TO }).runs[0].id;
}

function makeRetriesDue(store: Store) {
  store.db.prepare("UPDATE sync_tasks SET available_at='2000-01-01T00:00:00.000Z' WHERE state='queued'").run();
}

function markCoverageComplete(store: Store) {
  const id = store.createRun('kopis', TEST_CITY.id, TEST_FROM, TEST_TO);
  const task = store.nextTask(); assert.ok(task); assert.equal(task.run_id, id);
  store.finishTask(task);
}

test('dates: 31-day inclusive chunks cover leap/year boundaries with no gaps or overlaps', () => {
  for (const [from, to, lengths] of [
    ['2026-01-01', '2026-01-01', [1]],
    ['2026-01-01', '2026-01-31', [31]],
    ['2026-01-01', '2026-02-01', [31, 1]],
    ['2024-02-01', '2024-03-03', [31, 1]],
    ['2025-12-20', '2026-02-20', [31, 31, 1]],
  ] as const) {
    const chunks = dateChunks(from, to);
    assert.equal(chunks[0].from, from); assert.equal(chunks.at(-1)!.to, to);
    assert.deepEqual(chunks.map(c => (Date.parse(c.to) - Date.parse(c.from)) / 86_400_000 + 1), [...lengths]);
    chunks.slice(1).forEach((c, i) => assert.equal(c.from, addDays(chunks[i].to, 1)));
  }
});

test('dates: impossible dates, non-ISO input and reversed ranges are rejected', () => {
  assert.equal(isDate('2024-02-29'), true);
  for (const value of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-1-01', 'not-a-date']) {
    assert.equal(isDate(value), false, value);
    assert.throws(() => dateChunks(value, TEST_TO));
  }
  assert.throws(() => dateChunks(TEST_TO, TEST_FROM));
});

test('store: upsert identity is (source, sourceId), and source refresh preserves bookmark, note and hydrated details', t => {
  const { store } = temporaryStore(t);
  const original = performance('identity', { detailState: 'complete', price: 'TEST 10,000원', priceType: 'paid', age: 'TEST 12세', runtime: 'TEST 90분' });
  const id = store.upsert(original);
  store.bookmark(id, true, 'TEST 사용자 메모\n둘째 줄');
  const refreshed = store.upsert(performance('identity', { title: 'TEST 변경된 제목' }));
  assert.equal(refreshed, id); assert.equal(store.search({}).total, 1);
  const item = store.item(id)!;
  assert.equal(item.title, 'TEST 변경된 제목'); assert.equal(item.bookmarked, true);
  assert.equal(item.note, 'TEST 사용자 메모\n둘째 줄');
  assert.equal(item.price, original.price); assert.equal(item.age, original.age);
  assert.equal(item.runtime, original.runtime); assert.equal(item.detailState, 'complete');
  assert.equal(store.bookmark(id, true).note, item.note);
  assert.notEqual(store.upsert({ ...original, source: 'culture' }), id);
  assert.deepEqual(store.search({}).sourceCounts, { kopis: 1, culture: 1 });
});

test('store: hydrated values and user data survive a real SQLite close/reopen', t => {
  const fixture = temporaryStore(t);
  const id = fixture.store.upsert(performance('persist', { detailState: 'complete' }));
  fixture.store.bookmark(id, true, 'TEST 영구 메모');
  const reopened = fixture.reopen();
  assert.equal(reopened.item(id)!.note, 'TEST 영구 메모');
  assert.equal(reopened.item(id)!.bookmarked, true);
  assert.equal(reopened.item(id)!.detailState, 'complete');
});

test('store: excluded/review rows stay out of results and each source retains independent counts', t => {
  const { store } = temporaryStore(t);
  store.upsert(performance('visible'));
  store.upsert(performance('visible', { source: 'culture' }));
  store.upsert(performance('excluded', { classification: 'excluded' }));
  store.upsert(performance('review', { classification: 'review', reviewReason: 'TEST 분류 불명' }));
  const result = store.search({});
  assert.equal(result.total, 2); assert.deepEqual(result.sourceCounts, { kopis: 1, culture: 1 });
  assert.equal(store.counts().excluded, 1); assert.equal(store.counts().review, 1);
  assert.equal(result.items.some(item => 'raw' in item), false);
});

test('store: unknown admission is not free; price/age filters signal incomplete details until hydration', t => {
  const { store } = temporaryStore(t);
  markCoverageComplete(store);
  store.upsert(performance('unknown', { detailState: 'complete' }));
  store.upsert(performance('free', { detailState: 'complete', price: 'TEST 무료', priceType: 'free', age: 'TEST 전체 관람가' }));
  store.upsert(performance('pending'));
  store.upsert(performance('failed', { detailState: 'failed' }));
  const base = { source: 'kopis' as const, cities: TEST_CITY.id, from: TEST_FROM, to: TEST_TO };
  const free = store.search({ ...base, price: 'free' });
  assert.deepEqual(free.items.map(p => p.sourceId), ['TEST-free']);
  assert.equal(free.pendingDetails, 2); assert.equal(free.partial, true);
  assert.deepEqual(store.search({ ...base, price: 'unknown' }).items.map(p => p.sourceId), ['TEST-unknown']);
  assert.equal(store.search({ ...base, age: '전체' }).partial, true);
  store.upsert(performance('pending', { detailState: 'complete', price: 'TEST 유료', priceType: 'paid' }));
  store.upsert(performance('failed', { detailState: 'complete' }));
  assert.equal(store.search({ ...base, price: 'free' }).partial, false);
  assert.equal(store.search({ ...base, price: 'free' }).pendingDetails, 0);
  assert.equal(store.search({ ...base, price: 'unknown' }).total, 2);
});

test('store: date overlap, city, source, bookmark, literal search and pagination agree', t => {
  const { store } = temporaryStore(t);
  const id = store.upsert(performance('overlap', { startDate: '2025-12-20', endDate: TEST_FROM, title: "TEST %_' OR 1=1 --" }));
  store.bookmark(id, true, 'TEST note');
  store.upsert(performance('other', { cityId: TEST_OTHER_CITY.id }));
  store.upsert(performance('later', { startDate: '2026-02-01', endDate: '2026-02-02' }));
  const result = store.search({ cities: TEST_CITY.id, from: TEST_FROM, to: TEST_TO, source: 'kopis', bookmarked: 'true' });
  assert.equal(result.total, 1); assert.equal(result.items[0].id, id);
  assert.equal(store.search({ q: "%' OR 1=1 --" }).total, 0);
  assert.equal(store.search({ q: "%_' OR 1=1 --" }).total, 1);
  const first = store.search({ limit: '1', page: '1' });
  const second = store.search({ limit: '1', page: '2' });
  assert.equal(first.pages, 3); assert.notEqual(first.items[0].id, second.items[0].id);
});

test('store: interrupted claims recover on restart while completed and explicitly paused work are preserved', t => {
  const fixture = temporaryStore(t);
  const id = fixture.store.createRun('kopis', TEST_CITY.id, TEST_FROM, '2026-02-01');
  const first = fixture.store.nextTask(); assert.ok(first); fixture.store.finishTask(first);
  const interrupted = fixture.store.nextTask(); assert.ok(interrupted);
  const pausedId = fixture.store.createRun('kopis', TEST_OTHER_CITY.id, TEST_FROM, TEST_TO);
  fixture.store.setRunState(pausedId, 'paused');
  const reopened = fixture.reopen();
  assert.equal(reopened.runs().find(r => r.id === pausedId)!.state, 'paused');
  const reclaimed = reopened.nextTask(); assert.ok(reclaimed);
  assert.equal(reclaimed.id, interrupted.id); assert.equal(reclaimed.page, interrupted.page);
  reopened.finishTask(reclaimed);
  const run = reopened.runs().find(r => r.id === id)!;
  assert.equal(run.tasksDone, 2); assert.equal(run.state, 'complete');
  assert.equal(reopened.nextTask(), undefined);
});

test('store: a newer failed collection cannot reuse old complete coverage; detail-only completion is not collection coverage', t => {
  const { store } = temporaryStore(t);
  const filters = { cities: TEST_CITY.id, source: 'kopis' as const, from: TEST_FROM, to: TEST_TO };
  markCoverageComplete(store);
  assert.equal(store.search(filters).partial, false);
  const later = store.createRun('kopis', TEST_CITY.id, TEST_FROM, TEST_TO);
  store.setRunState(later, 'partial');
  assert.equal(store.search(filters).partial, true);
  const detailOnly = store.createRun('kopis', TEST_OTHER_CITY.id, TEST_FROM, TEST_TO, true);
  store.setRunState(detailOnly, 'complete');
  assert.equal(store.search({ ...filters, cities: TEST_OTHER_CITY.id }).partial, true);
});

test('worker: scans every page of every 31-day chunk, hydrates unique items and counts excluded/review records', async t => {
  const requests: ListRequest[] = []; const details: string[] = [];
  const { store, worker } = await workerFixture(t, { kopis: provider({
    async list(request) {
      requests.push(request);
      if (request.from === TEST_FROM && request.page === 1) return {
        items: [performance('first'), performance('exhibition', { classification: 'excluded' }), performance('review', { classification: 'review' })], hasMore: true,
      };
      if (request.from === TEST_FROM) return { items: [performance('second')], hasMore: false };
      return { items: [performance('first')], hasMore: false };
    },
    async detail(item) { details.push(item.sourceId); return { ...item, detailState: 'complete' }; },
  }) });
  const runId = worker.enqueue({ cities: [TEST_CITY.id], sources: ['kopis'], from: TEST_FROM, to: '2026-02-01' }).runs[0].id;
  for (let i = 0; i < 10; i++) await worker.tick();
  assert.deepEqual(requests.map(r => [r.from, r.to, r.page]).sort(), [
    [TEST_FROM, TEST_TO, 1], [TEST_FROM, TEST_TO, 2], ['2026-02-01', '2026-02-01', 1],
  ].sort());
  assert.ok(requests.every(r => r.pageSize === 100));
  assert.deepEqual(details.sort(), ['TEST-first', 'TEST-review', 'TEST-second']);
  const run = store.runs().find(r => r.id === runId)!;
  assert.equal(run.state, 'complete'); assert.equal(run.tasksTotal, 6); assert.equal(run.tasksDone, 6);
  assert.equal(run.items, 2); assert.equal(run.excluded, 1); assert.equal(run.review, 1);
});

test('worker: transient detail failure retries with backoff, stops after three attempts and resumes only unfinished work', async t => {
  let listCalls = 0; let detailCalls = 0; let fail = true;
  const { store, worker } = await workerFixture(t, { kopis: provider({
    async list() { listCalls++; return { items: [performance('retry')], hasMore: false }; },
    async detail(item) { detailCalls++; if (fail) throw new Error('TEST transient failure'); return { ...item, detailState: 'complete' }; },
  }) });
  const id = enqueue(worker);
  await worker.tick();
  const itemId = store.search({}).items[0].id;
  store.bookmark(itemId, true, 'TEST retain through failed sync');
  await worker.tick();
  const delayed = store.db.prepare("SELECT available_at FROM sync_tasks WHERE kind='detail'").get() as { available_at: string };
  assert.ok(Date.parse(delayed.available_at) > Date.now());
  await worker.tick(); assert.equal(detailCalls, 1, 'Backoff must suppress an immediate retry');
  for (let i = 0; i < 2; i++) { makeRetriesDue(store); await worker.tick(); }
  assert.equal(detailCalls, 3); assert.equal(store.runs()[0].state, 'partial');
  assert.equal(store.item(itemId)!.detailState, 'failed');
  assert.equal(store.item(itemId)!.note, 'TEST retain through failed sync');
  fail = false; store.setRunState(id, 'queued'); await worker.tick();
  assert.equal(listCalls, 1); assert.equal(detailCalls, 4);
  assert.equal(store.runs()[0].state, 'complete'); assert.equal(store.item(itemId)!.detailState, 'complete');
});

test('worker: a later page failure retains earlier rows and retries only the failed page', async t => {
  const pages: number[] = []; let broken = true;
  const { store, worker } = await workerFixture(t, { kopis: provider({
    async list(request) {
      pages.push(request.page);
      if (request.page === 1) return { items: [performance('page-one')], hasMore: true };
      if (broken) throw Object.assign(new Error('TEST broken later page'), { kind: 'schema' });
      return { items: [performance('page-two')], hasMore: false };
    },
  }) });
  const id = enqueue(worker);
  await worker.tick();
  const retainedId = store.search({}).items[0].id;
  store.bookmark(retainedId, true, 'TEST retain first page');
  for (let i = 0; i < 5; i++) { makeRetriesDue(store); await worker.tick(); }
  assert.equal(store.runs()[0].state, 'partial'); assert.equal(store.search({}).total, 1);
  assert.equal(pages.filter(page => page === 1).length, 1);
  assert.equal(pages.filter(page => page === 2).length, 3);
  broken = false; store.setRunState(id, 'queued');
  for (let i = 0; i < 3; i++) await worker.tick();
  assert.equal(store.runs()[0].state, 'complete'); assert.equal(store.search({}).total, 2);
  assert.equal(pages.filter(page => page === 1).length, 1);
  assert.equal(store.item(retainedId)!.note, 'TEST retain first page');
});

test('worker: a fresh empty collection does not delete previously stored performances or infer cancellation', async t => {
  const { store, worker } = await workerFixture(t, { kopis: provider() });
  const id = store.upsert(performance('not-returned', { detailState: 'complete', status: 'TEST original status' }));
  store.bookmark(id, true, 'TEST retain historical case');
  enqueue(worker); await worker.tick();
  assert.equal(store.runs()[0].state, 'complete');
  assert.equal(store.search({}).total, 1); assert.equal(store.item(id)!.status, 'TEST original status');
  assert.equal(store.item(id)!.note, 'TEST retain historical case');
});

for (const kind of ['auth', 'quota'] as const) {
  test(`worker: ${kind} blocks all runs for the affected source without exposing errors or retrying credentials`, async t => {
    let failedCalls = 0; let unaffectedCalls = 0;
    const { store, worker } = await workerFixture(t, {
      kopis: provider({ async list() { failedCalls++; throw Object.assign(new Error(`TEST upstream serviceKey=${TEST_SECRET}`), { kind }); } }),
      culture: provider({ source: 'culture', async list() { unaffectedCalls++; return { items: [], hasMore: false }; } }),
    });
    enqueue(worker, [TEST_CITY.id, TEST_OTHER_CITY.id]);
    worker.enqueue({ cities: [TEST_CITY.id], sources: ['culture'], from: TEST_FROM, to: TEST_TO });
    for (let i = 0; i < 8; i++) { makeRetriesDue(store); await worker.tick(); }
    assert.equal(failedCalls, 1); assert.equal(unaffectedCalls, 1);
    assert.ok(store.runs().filter(r => r.source === 'kopis').every(r => r.state === (kind === 'auth' ? 'partial' : 'quota_wait')));
    assert.equal(store.runs().find(r => r.source === 'culture')!.state, 'complete');
    assert.equal(JSON.stringify(store.runs()).includes(TEST_SECRET), false);
    const taskErrors = store.db.prepare('SELECT error FROM sync_tasks').all();
    assert.equal(JSON.stringify(taskErrors).includes(TEST_SECRET), false);
  });
}

test('worker: pause/resume keeps completed page checkpoints and prevents calls while paused', async t => {
  const pages: number[] = [];
  const { store, worker } = await workerFixture(t, { kopis: provider({
    async list(request) { pages.push(request.page); return { items: [], hasMore: request.page === 1 }; },
  }) });
  const id = enqueue(worker); await worker.tick();
  store.setRunState(id, 'paused'); await worker.tick();
  assert.deepEqual(pages, [1]); assert.equal(store.runs()[0].state, 'paused');
  store.setRunState(id, 'queued'); await worker.tick();
  assert.deepEqual(pages, [1, 2]); assert.equal(store.runs()[0].state, 'complete');
});

test('worker: stop aborts an in-flight request and restart retains its checkpoint without consuming a retry', async t => {
  let abortObserved = false; let calls = 0; let entered!: () => void;
  const enteredRequest = new Promise<void>(resolve => { entered = resolve; });
  const { store, worker } = await workerFixture(t, { kopis: provider({
    async list(_request, signal) {
      calls++;
      if (calls > 1) return { items: [], hasMore: false };
      entered();
      return new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => { abortObserved = true; reject(new Error('TEST aborted')); }, { once: true });
      });
    },
  }) });
  enqueue(worker);
  t.mock.timers.tick(50); await enteredRequest;
  await worker.stop();
  assert.equal(abortObserved, true);
  const task = store.db.prepare('SELECT state,attempts FROM sync_tasks').get();
  assert.deepEqual({ ...task }, { state: 'queued', attempts: 0 });
  worker.start(); await worker.tick();
  assert.equal(calls, 2); assert.equal(store.runs()[0].state, 'complete');
});

test('worker: detail backfill ignores detail-dependent filters and deduplicates outstanding work', async t => {
  const { store, worker } = await workerFixture(t, { kopis: provider() });
  store.upsert(performance('pending')); store.upsert(performance('failed', { detailState: 'failed' }));
  store.upsert(performance('complete', { detailState: 'complete' }));
  store.upsert(performance('not-connected', { source: 'culture' }));
  assert.equal(worker.enqueueDetails({ cities: TEST_CITY.id, price: 'free', age: 'TEST' }), 2);
  assert.equal(worker.enqueueDetails({ cities: TEST_CITY.id, price: 'free' }), 0);
  await worker.tick(); await worker.tick();
  assert.equal(store.search({ source: 'kopis' }).pendingDetails, 0);
});

test('export: two sheets preserve literal formula-looking strings, Korean, URL, unknown price and snapshot evidence', async t => {
  const { store } = temporaryStore(t);
  const titles = ['=1+1', '+SUM(A1:A2)', '-1+2', '@SUM(A1:A2)', '\t=HYPERLINK("https://example.invalid")'];
  const ids = titles.map((title, i) => {
    const id = store.upsert(performance(`xlsx-${i}`, { title, detailState: 'complete' }));
    store.bookmark(id, true, `=TEST 메모 ${i}\n한글`); return id;
  });
  const filters = { cities: TEST_CITY.id, bookmarked: 'true' };
  const pendingExport = exportWorkbook(store, filters);
  const lateId = store.upsert(performance('after-snapshot'));
  store.bookmark(lateId, true, 'TEST added after snapshot');
  store.bookmark(ids[0], true, 'TEST changed after snapshot');
  const bytes = await pendingExport;
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes as any);
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['공연 목록', '조회 근거']);
  const sheet = workbook.getWorksheet('공연 목록')!;
  assert.equal(sheet.rowCount, ids.length + 1);
  assert.deepEqual(sheet.getColumn(2).values.slice(2).sort(), [...titles].sort());
  sheet.eachRow((row, index) => {
    row.eachCell(cell => { assert.notEqual(cell.type, ExcelJS.ValueType.Formula); assert.equal(cell.formula, undefined); });
    if (index > 1) {
      assert.equal(row.getCell(7).value, '정보 미상'); assert.equal(row.getCell(8).value, '정보 미상');
      assert.equal(row.getCell(16).value, 'https://example.invalid/TEST-performance');
      assert.match(String(row.getCell(19).value), /^=TEST 메모 \d\n한글$/);
    }
  });
  const evidence = workbook.getWorksheet('조회 근거')!;
  const evidenceText = JSON.stringify(evidence.getSheetValues());
  assert.ok(evidenceText.includes(JSON.stringify(filters).replaceAll('"', '\\"')));
  assert.match(evidenceText, /부분 자료/); assert.match(evidenceText, /고유 공연 수가 아닙니다/);
  assert.equal(evidenceText.includes(TEST_SECRET), false);
  const selected = new ExcelJS.Workbook(); await selected.xlsx.load(await exportWorkbook(store, filters, [ids[0]]) as any);
  assert.equal(selected.getWorksheet('공연 목록')!.rowCount, 2);
});

test('HTTP: no-key bootstrap is empty, source status truthful, and configured test keys/raw are never returned', async t => {
  const { store, app } = await appFixture(t);
  const bootstrap = await app.inject({ url: '/api/bootstrap' });
  assert.equal(bootstrap.statusCode, 200);
  assert.ok(bootstrap.json().sources.every((s: { configured: boolean; count: number }) => !s.configured && s.count === 0));
  assert.equal((await app.inject({ url: '/api/performances' })).json().total, 0);
  const id = store.upsert(performance('private', { raw: { privateTestValue: TEST_SECRET } }));
  for (const url of ['/api/bootstrap', '/api/performances', `/api/performances/${id}`]) {
    const response = await app.inject({ url }); assert.equal(response.statusCode, 200);
    assert.equal(response.body.includes(TEST_SECRET), false); assert.equal(response.body.includes('privateTestValue'), false);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  }
  const sync = await app.inject({ method: 'POST', url: '/api/sync', headers: JSON_HEADERS,
    payload: { cities: [TEST_CITY.id], sources: ['kopis', 'culture'], from: TEST_FROM, to: TEST_TO } });
  assert.equal(sync.statusCode, 200); assert.deepEqual(sync.json(), { runs: [], skipped: ['kopis', 'culture'] });
});

test('HTTP: mutation header, Origin and Host checks reject cross-site requests before changing user data', async t => {
  const { store, app } = await appFixture(t);
  const id = store.upsert(performance('csrf'));
  const url = `/api/performances/${id}/bookmark`;
  for (const headers of [
    { 'content-type': 'application/json' },
    { ...JSON_HEADERS, origin: 'https://attacker.invalid' },
    { ...JSON_HEADERS, origin: 'null' },
    { ...JSON_HEADERS, host: 'attacker.invalid' },
  ]) {
    const response = await app.inject({ method: 'PUT', url, headers, payload: { bookmarked: true, note: 'TEST rejected' } });
    assert.equal(response.statusCode, 403); assert.equal(store.item(id)!.bookmarked, false);
  }
  const valid = await app.inject({ method: 'PUT', url, headers: { ...JSON_HEADERS, origin: 'http://127.0.0.1:4317' }, payload: { bookmarked: true, note: 'TEST accepted' } });
  assert.equal(valid.statusCode, 200); assert.equal(valid.json().note, 'TEST accepted');
  assert.equal((await app.inject({ url: '/api/bootstrap', headers: { host: 'attacker.invalid' } })).statusCode, 403);
});

test('HTTP: all mutations require application/json, including routes that do not inspect their body', async t => {
  const { store, app } = await appFixture(t, { kopis: provider() });
  const id = store.upsert(performance('content-type'));
  const response = await app.inject({ method: 'POST', url: `/api/performances/${id}/detail`,
    headers: { 'x-culture-request': '1', 'content-type': 'text/plain' }, payload: '{}' });
  assert.ok([400, 403, 415].includes(response.statusCode), `Expected non-JSON rejection; got ${response.statusCode}`);
  assert.equal(store.runs().length, 0);
});

for (const query of [
  'from=2026-02-30', 'from=2026-02-02&to=2026-02-01', 'source=bogus', 'price=bogus',
  'page=1.5', 'limit=1.5', 'page=Infinity', 'status=bogus', 'bookmarked=bogus',
]) {
  test(`HTTP: invalid search condition returns 400 (${query})`, async t => {
    const { store, app } = await appFixture(t);
    store.upsert(performance('validate-1')); store.upsert(performance('validate-2'));
    const response = await app.inject({ url: `/api/performances?${query}` });
    assert.equal(response.statusCode, 400, `Query ${query}: ${response.body}`);
  });
}

test('HTTP: malformed IDs, missing records, bad bookmarks and invalid sync requests fail without creating runs', async t => {
  const { store, app } = await appFixture(t, { kopis: provider() });
  for (const id of ['0', '-1', '1.5', 'abc', '9007199254740992']) assert.equal((await app.inject({ url: `/api/performances/${id}` })).statusCode, 400);
  assert.equal((await app.inject({ url: '/api/performances/99999' })).statusCode, 404);
  const id = store.upsert(performance('bad-bookmark'));
  for (const payload of [{ bookmarked: 'true' }, { bookmarked: true, note: 'x'.repeat(20_001) }]) {
    assert.equal((await app.inject({ method: 'PUT', url: `/api/performances/${id}/bookmark`, headers: JSON_HEADERS, payload })).statusCode, 400);
  }
  for (const payload of [
    { cities: ['missing'], sources: ['kopis'], from: TEST_FROM, to: TEST_TO },
    { cities: [], sources: ['kopis'], from: TEST_FROM, to: TEST_TO },
    { cities: [TEST_CITY.id], sources: ['bogus'], from: TEST_FROM, to: TEST_TO },
    { cities: [TEST_CITY.id], sources: ['kopis'], from: '2026-02-30', to: TEST_TO },
    { cities: [TEST_CITY.id], sources: ['kopis'], from: '2020-01-01', to: '2026-01-01' },
  ]) assert.equal((await app.inject({ method: 'POST', url: '/api/sync', headers: JSON_HEADERS, payload })).statusCode, 400);
  assert.equal(store.runs().length, 0); assert.equal(store.item(id)!.bookmarked, false);
});

test('HTTP: search, bookmark and selected Excel export agree on persisted records', async t => {
  const { store, app } = await appFixture(t);
  const id = store.upsert(performance('http-export', { detailState: 'complete' }));
  store.upsert(performance('http-not-selected', { detailState: 'complete' }));
  await app.inject({ method: 'PUT', url: `/api/performances/${id}/bookmark`, headers: JSON_HEADERS, payload: { bookmarked: true, note: '=TEST literal note' } });
  const search = await app.inject({ url: '/api/performances?bookmarked=true' });
  assert.equal(search.json().total, 1); assert.equal(search.json().items[0].id, id);
  const response = await app.inject({ url: `/api/export.xlsx?bookmarked=true&ids=${id}` });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers['content-type']), /spreadsheetml/);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(response.rawPayload as any);
  const sheet = workbook.getWorksheet('공연 목록')!;
  assert.equal(sheet.rowCount, 2); assert.equal(sheet.getCell('B2').value, search.json().items[0].title);
  assert.equal(sheet.getCell('S2').value, '=TEST literal note'); assert.equal(sheet.getCell('S2').formula, undefined);
});
