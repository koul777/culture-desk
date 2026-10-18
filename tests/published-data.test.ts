import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleCloudRequest, type CloudOptions } from '../server/cloud/handler.js';
import { readPublicSnapshot, type PublicReadonlySnapshot } from '../server/cloud/readonly-fallback.js';
import { Store } from '../server/store.js';
import { NATIONAL_CITIES } from '../server/providers/cities.js';
import { runDailyPublish, type Collect } from '../scripts/run-daily-publish.js';
import { inspectSnapshot, prepareDeployment } from '../scripts/release-state.js';
import type { PerformanceInput } from '../shared/types.js';

const snapshotAt = '2026-10-17T00:30:00.000Z';
const row = (id: number, changes: Record<string, unknown> = {}) => ({
  id, source: 'kopis', sourceId: `TEST_${id}`, title: 'TEST 공연', cityId: 'andong', startDate: '2026-10-01', endDate: '2026-10-31',
  genre: '음악', sourceGenre: '', venue: 'TEST 공연장', address: '', poster: '', sourceUrl: '', price: '', priceType: 'unknown', age: '',
  runtime: '', cast: '', producer: '', organizer: '', contact: '', schedule: '', description: '', status: '',
  latitude: 36.56, longitude: 128.72, locationPrecision: 'venue', detailState: 'complete', classification: 'performance', reviewReason: '',
  updatedAt: '2026-10-16T10:00:00.000Z', ...changes,
});
const refresh = { status: 'complete', day: '2026-10-17', from: '2026-10-01', to: '2027-01-17',
  counts: { expectedRuns: 460, completeRuns: 460, totalTasks: 9000, doneTasks: 9000, remaining: 0, performances: 2 },
  lastSuccessAt: snapshotAt, updatedAt: snapshotAt, error: null } as const;
const published = (): PublicReadonlySnapshot => ({ version: 1, snapshotAt, refresh,
  coverage: { from: '2026-10-01', to: '2027-01-17', pairs: ['kopis:andong'] },
  performances: [
    row(1, { venueInfo: { facility: 'TEST', halls: [{ name: '대공연장', seats: 500 }], amenities: ['주차장'], booking: [] } }),
    row(2, { source: 'culture', sourceId: 'TEST_C2', cityId: 'gangneung' }),
  ] as any });
const options = (snapshot = published()): CloudOptions => ({ env: {}, readonlyFallback: { load: async () => snapshot } });
const request = (route: string, method = 'GET', body?: unknown) => new Request(`https://culture.test${route}`, { method,
  headers: body !== undefined ? { 'content-type': 'application/json', 'x-culture-request': '1' } : {}, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

test('the web service serves the published snapshot as normal data with its refresh state, never as an outage', async () => {
  const opts = options();
  const boot = await (await handleCloudRequest(request('/api/bootstrap'), opts)).json();
  assert.deepEqual(boot.published, { mode: 'published', snapshotAt }); assert.equal(boot.fallback, undefined); assert.deepEqual(boot.runs, []);
  assert.equal(boot.automaticRefresh.enabled, true); assert.equal(boot.automaticRefresh.status, 'complete');
  assert.equal(boot.automaticRefresh.lastSuccessAt, snapshotAt); assert.deepEqual(boot.automaticRefresh.schedule.retries, ['06:47', '12:47', '20:47']);
  assert.ok(boot.sources.every((source: any) => source.configured && source.lastSync === snapshotAt));
  for (const route of ['/api/performances', '/api/map']) {
    const response = await handleCloudRequest(request(route), opts);
    assert.equal(response.status, 200); assert.equal(response.headers.get('x-culture-data-mode'), 'published');
    const body = await response.json(); assert.equal(body.snapshotAt, snapshotAt); assert.equal(body.fallback, undefined); assert.equal(body.total, 2);
  }
  const detail = await (await handleCloudRequest(request('/api/performances/1'), opts)).json();
  assert.equal(detail.venueInfo.halls[0].seats, 500);
});

test('audited coverage removes the false "not collected" notice only for covered regions, sources and dates', async () => {
  const opts = options();
  const search = async (query: string) => (await (await handleCloudRequest(request(`/api/performances?${query}`), opts)).json()).partial;
  assert.equal(await search('cities=andong&source=kopis&from=2026-10-05&to=2026-12-31'), false);
  assert.equal(await search('cities=andong&source=kopis&from=2026-09-01&to=2026-12-31'), true, 'dates before the window were not collected');
  assert.equal(await search('cities=andong&from=2026-10-05&to=2026-12-31'), true, 'culture:andong is not covered');
  assert.equal(await search('cities=gangneung&source=culture&from=2026-10-05&to=2026-10-06'), true);
});

test('the published service has no collection, cron or database path and reports a missing artifact safely', async () => {
  const opts = options();
  for (const [route, method] of [['/api/sync', 'POST'], ['/api/details', 'POST'], ['/api/cloud/tick', 'POST'], ['/api/performances/1/detail', 'POST'], ['/api/cloud/cron', 'GET']] as const) {
    assert.equal((await handleCloudRequest(request(route, method, method === 'POST' ? {} : undefined), opts)).status, 404, route);
  }
  const head = await handleCloudRequest(request('/api/bootstrap', 'HEAD'), opts); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  const missing = await handleCloudRequest(request('/api/performances'), { env: {}, readonlyFallback: { load: async () => undefined } });
  assert.equal(missing.status, 503); assert.equal((await missing.json()).code, 'SNAPSHOT_UNAVAILABLE');
});

test('the database path is used only when explicitly configured', async () => {
  let calls = 0;
  const repository = { withStore: async () => { calls++; throw Object.assign(new Error('TEST quota'), { code: '53000' }); } };
  const response = await handleCloudRequest(request('/api/performances'), { env: { CULTURE_DATA_SOURCE: 'database' }, repository, readonlyFallback: { load: async () => published() } });
  assert.equal(calls, 1); assert.equal((await response.json()).fallback.mode, 'snapshot');
});

const performance = (sourceId: string): PerformanceInput => ({ ...row(0), sourceId, raw: null } as any);
function setup(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'culture-daily-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snapshotPath = path.join(dir, 'public-snapshot.json');
  writeFileSync(snapshotPath, JSON.stringify(published()));
  return { snapshotPath, stateDirectory: path.join(dir, 'state') };
}
const partialCollect: Collect = async (window, directory) => {
  const store = new Store(path.join(directory, 'collection.db'), NATIONAL_CITIES);
  try { store.upsert(performance('TEST_NEW'), store.createRun('kopis', 'andong', window.from, window.to)); } finally { store.close(); }
  writeFileSync(path.join(directory, 'checkpoint-1.db'), 'checkpoint');
  return { exitCode: 2 };
};
const completeCollect: Collect = async (window, directory) => {
  const store = new Store(path.join(directory, 'collection.db'), NATIONAL_CITIES);
  try {
    for (const city of NATIONAL_CITIES) for (const source of ['kopis', 'culture'] as const) {
      if (!store.db.prepare('SELECT 1 FROM sync_runs WHERE source=? AND city_id=?').get(source, city.id)) store.createRun(source, city.id, window.from, window.to);
    }
    store.db.exec("UPDATE sync_tasks SET state='done'; UPDATE sync_runs SET state='complete'");
  } finally { store.close(); }
  return { exitCode: 0 };
};
const window = { day: '2026-10-18', from: '2026-10-18', to: '2026-10-18' };

test('a scheduled run merges into the earlier public rows, publishes partial progress and resumes to completion', async t => {
  const { snapshotPath, stateDirectory } = setup(t);
  const first = await runDailyPublish({ stateDirectory, snapshotPath, collect: partialCollect, window, now: () => new Date('2026-10-17T19:30:00Z') });
  assert.ok(!('skipped' in first) && first.state.status === 'retry_wait');
  let out = await readPublicSnapshot(snapshotPath);
  assert.deepEqual(out.performances.map(item => item.sourceId).sort(), ['TEST_1', 'TEST_C2', 'TEST_NEW']);
  assert.equal(out.refresh?.lastSuccessAt, snapshotAt, 'the last completed refresh is carried over, not invented');
  assert.ok(out.performances.find(item => item.sourceId === 'TEST_1')!.venueInfo, 'seeded rows keep published venue facts');
  assert.ok(!existsSync(path.join(stateDirectory, 'collect', 'checkpoint-1.db')));
  assert.ok(readFileSync(snapshotPath, 'utf8').split('\n').length >= out.performances.length + 2, 'one record per line');
  assert.equal(readFileSync(path.join(stateDirectory, 'public-snapshot.json'), 'utf8'), readFileSync(snapshotPath, 'utf8'), 'the state artifact carries the published data');

  const second = await runDailyPublish({ stateDirectory, snapshotPath, collect: completeCollect, window, now: () => new Date('2026-10-17T21:50:00Z') });
  assert.ok(!('skipped' in second) && second.state.status === 'complete');
  out = await readPublicSnapshot(snapshotPath);
  assert.equal(out.refresh?.lastSuccessAt, '2026-10-17T21:50:00.000Z'); assert.equal(out.coverage?.pairs.length, 460);
  assert.equal(out.performances.length, 3); assert.ok(!existsSync(path.join(stateDirectory, 'collect')));

  let called = false;
  const third = await runDailyPublish({ stateDirectory, snapshotPath, collect: async () => { called = true; return { exitCode: 0 }; }, window });
  assert.ok('skipped' in third); assert.equal(called, false);
});

test('a new day discards the previous day\'s partial collection but keeps its merged rows', async t => {
  const { snapshotPath, stateDirectory } = setup(t);
  await runDailyPublish({ stateDirectory, snapshotPath, collect: partialCollect, window });
  let resumed = true;
  await runDailyPublish({ stateDirectory, snapshotPath, window: { day: '2026-10-19', from: '2026-10-19', to: '2026-10-19' },
    collect: async (_window, directory) => { resumed = existsSync(path.join(directory, 'collection.db')); return { exitCode: 1 }; } });
  assert.equal(resumed, false);
  const out = await readPublicSnapshot(snapshotPath);
  assert.ok(out.performances.some(item => item.sourceId === 'TEST_NEW')); assert.equal(out.refresh?.status, 'retry_wait'); assert.equal(out.refresh?.day, '2026-10-19');
});

test('export failure retains the previous public snapshot and resumes the completed collection', async t => {
  const { snapshotPath, stateDirectory } = setup(t);
  const before = readFileSync(snapshotPath, 'utf8');
  await assert.rejects(runDailyPublish({ stateDirectory, snapshotPath, window,
    collect: async (range, directory, batch) => {
      await completeCollect(range, directory, batch);
      const store = new Store(path.join(directory, 'collection.db'), NATIONAL_CITIES);
      try { store.upsert({ ...performance('INVALID_EXPORT'), sourceUrl: 'https://provider.test?api_key=TEST_SECRET' }); }
      finally { store.close(); }
      return { exitCode: 0 };
    } }), /Public export rejected/);
  assert.equal(readFileSync(snapshotPath, 'utf8'), before);
  assert.equal(JSON.parse(readFileSync(path.join(stateDirectory, 'job.json'), 'utf8')).status, 'retry_wait');
  assert.ok(existsSync(path.join(stateDirectory, 'collect', 'collection.db')));
  const result = await runDailyPublish({ stateDirectory, snapshotPath, window,
    collect: async (_range, directory) => {
      const store = new Store(path.join(directory, 'collection.db'), NATIONAL_CITIES);
      try {
        assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sync_runs').get()!.n, 460, 'completed checkpoints survive export failure');
        store.upsert(performance('INVALID_EXPORT'));
      } finally { store.close(); }
      return { exitCode: 0 };
    } });
  assert.equal(result.state.status, 'complete');
  assert.ok(!existsSync(path.join(stateDirectory, 'collect')));
  assert.equal((await readPublicSnapshot(snapshotPath)).performances.length, 3);
});

test('a completed day restores its saved snapshot or rebuilds a missing export without recollection', async t => {
  const { snapshotPath, stateDirectory } = setup(t);
  await runDailyPublish({ stateDirectory, snapshotPath, collect: completeCollect, window });
  const saved = readFileSync(snapshotPath, 'utf8');
  writeFileSync(snapshotPath, JSON.stringify(published()));
  const collect: Collect = async () => { assert.fail('a completed day must not collect again'); };
  await runDailyPublish({ stateDirectory, snapshotPath, collect, window });
  assert.equal(readFileSync(snapshotPath, 'utf8'), saved);
  rmSync(path.join(stateDirectory, 'public-snapshot.json'));
  await runDailyPublish({ stateDirectory, snapshotPath, collect, window });
  assert.equal((await readPublicSnapshot(snapshotPath)).refresh?.status, 'complete');
  assert.ok(existsSync(path.join(stateDirectory, 'public-snapshot.json')));
});

test('a missing production database is seeded from the saved snapshot before the older checkout baseline', async t => {
  const { snapshotPath, stateDirectory } = setup(t);
  await runDailyPublish({ stateDirectory, snapshotPath, collect: partialCollect, window });
  rmSync(path.join(stateDirectory, 'production.db'));
  writeFileSync(snapshotPath, JSON.stringify(published()));
  await runDailyPublish({ stateDirectory, snapshotPath, window: { day: '2026-10-19', from: '2026-10-19', to: '2026-10-19' },
    collect: async () => ({ exitCode: 1 }) });
  const out = await readPublicSnapshot(snapshotPath);
  assert.ok(out.performances.some(item => item.sourceId === 'TEST_NEW'), 'newer published rows survive loss of the collection database');
  assert.equal(out.refresh?.lastSuccessAt, snapshotAt);
});

test('planner recovery rebuilds a corrupt saved export for a complete day and prepares it without recollection', async t => {
  const { snapshotPath, stateDirectory } = setup(t);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const currentWindow = { day, from: day, to: day };
  await runDailyPublish({ stateDirectory, snapshotPath, collect: completeCollect, window: currentWindow });
  assert.ok(existsSync(path.join(stateDirectory, 'production.db')));
  assert.equal(JSON.parse(readFileSync(path.join(stateDirectory, 'job.json'), 'utf8')).status, 'complete');
  writeFileSync(path.join(stateDirectory, 'public-snapshot.json'), '{broken');
  const script = fileURLToPath(new URL('../scripts/release-state.ts', import.meta.url));
  const planned = spawnSync(process.execPath, [script, 'plan'], { cwd: path.dirname(snapshotPath), encoding: 'utf8', env: {
    ...process.env, DAILY_STATE_DIRECTORY: stateDirectory, GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'recovery-commit', GITHUB_EVENT_NAME: 'schedule', GITHUB_OUTPUT: '',
  } });
  assert.equal(planned.status, 0, planned.stderr);
  assert.match(planned.stdout, /collect=true/);
  assert.match(planned.stdout, /deploy=true/);
  const rebuilt = await runDailyPublish({ stateDirectory, snapshotPath, window: currentWindow,
    collect: async () => { assert.fail('the complete database must rebuild its snapshot without API recollection'); } });
  assert.ok('skipped' in rebuilt);
  const prepared = prepareDeployment(stateDirectory, snapshotPath, 'production', 'recovery-commit');
  assert.equal(prepared.snapshotSha256, inspectSnapshot(snapshotPath)!.sha256);
  assert.equal(inspectSnapshot(path.join(stateDirectory, 'public-snapshot.json'))!.refresh?.status, 'complete');
  assert.equal((await readPublicSnapshot(snapshotPath)).performances.length, 2);
});
