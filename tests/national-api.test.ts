import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import type { City, PerformanceInput, Provider } from '../shared/types.js';

// Synthetic regions verify transport/queue scale without claiming real administrative codes.
const cities: City[] = Array.from({ length: 250 }, (_, index) => ({
  id: `test-national-region-${String(index).padStart(3, '0')}`,
  name: `TEST 지역 ${index}`, sido: `TEST 시도 ${Math.floor(index / 20)}`, sigungu: `TEST 시군구 ${index}`,
  kopisSido: '90', kopisSigungu: String(9000 + index), aliases: [`TEST 지역 ${index}`],
  latitude: 36 + index / 10000, longitude: 127 + index / 10000,
}));
const cityCsv = cities.map(city => city.id).join(',');
const config = { port: 4317, databasePath: ':memory:', keys: { kopis: '', culture: '' }, requestIntervalMs: 100, syncIntervalHours: 24 };
const headers = { 'content-type': 'application/json', 'x-culture-request': '1' };
const performance = (city: City, index: number): PerformanceInput => ({
  source: 'kopis', sourceId: `TEST_NATIONAL_${index}`, title: `TEST 공연 ${index}`, cityId: city.id,
  startDate: '2026-10-01', endDate: '2026-10-31', genre: '음악', sourceGenre: 'TEST 음악',
  venue: 'TEST 공연장', address: '', poster: '', sourceUrl: '', latitude: city.latitude, longitude: city.longitude,
  locationPrecision: 'venue', price: 'TEST 무료', priceType: 'free', age: '', runtime: '', cast: '', producer: '',
  organizer: '', contact: '', schedule: '', description: '', status: '', detailState: 'complete',
  classification: 'performance', reviewReason: '', raw: null,
});

test('250-region CSV filters retain every region in paginated search and map results', async () => {
  assert.ok(cityCsv.length > 1000 && cityCsv.length < 15000);
  const store = new Store(':memory:', cities);
  const { app } = await createApp(config, { store, startWorker: false, providers: {}, serveStatic: false });
  try {
    for (const [index, city] of cities.entries()) store.upsert(performance(city, index));
    const query = new URLSearchParams({ cities: cityCsv, from: '2026-10-01', to: '2026-10-31', limit: '100' });
    const search = await app.inject(`/api/performances?${query}`);
    assert.equal(search.statusCode, 200);
    assert.equal(search.json().total, 250); assert.equal(search.json().items.length, 100); assert.equal(search.json().pages, 3);
    const lastPage = await app.inject(`/api/performances?${query}&page=3`);
    assert.equal(lastPage.statusCode, 200); assert.equal(lastPage.json().items.length, 50);
    const map = await app.inject(`/api/map?${query}`);
    assert.equal(map.statusCode, 200); assert.equal(map.json().total, 250); assert.equal(map.json().items.length, 250);
    assert.equal(map.json().truncated, false);
    assert.deepEqual(new Set(map.json().items.map((item: { cityId: string }) => item.cityId)), new Set(cities.map(city => city.id)));
  } finally { await app.close(); store.close(); }
});

test('250 regions enqueue 500 source-region runs with a complete receipt and zero provider calls', async () => {
  let calls = 0;
  const makeProvider = (source: 'kopis' | 'culture'): Provider => ({ source,
    list: async () => { calls++; throw new Error('TEST providers must not run'); },
    detail: async () => { calls++; throw new Error('TEST providers must not run'); },
  });
  const store = new Store(':memory:', cities);
  const { app } = await createApp(config, { store, startWorker: false, providers: { kopis: makeProvider('kopis'), culture: makeProvider('culture') }, serveStatic: false });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/sync', headers,
      payload: { cities: cities.map(city => city.id), sources: ['kopis','culture'], from: '2026-10-01', to: '2026-10-31' } });
    assert.equal(response.statusCode, 200);
    assert.equal(store.runs(1000).length, 500);
    assert.equal(response.json().runs.length, 500);
    assert.equal(new Set(response.json().runs.map((run: { cityId: string; source: string }) => `${run.source}:${run.cityId}`)).size, 500);
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM sync_tasks').get()!).n, 500);
    assert.ok(store.runs(1000).every(run => run.state === 'queued'));
    assert.equal(calls, 0);
  } finally { await app.close(); store.close(); }
});

test('unknown regions reject the entire collection request while ordinary text filters keep their 1000-character limit', async () => {
  const store = new Store(':memory:', cities);
  const provider: Provider = { source: 'kopis', list: async () => { throw new Error('TEST no provider calls'); }, detail: async item => item };
  const { app } = await createApp(config, { store, startWorker: false, providers: { kopis: provider }, serveStatic: false });
  try {
    const invalid = await app.inject({ method: 'POST', url: '/api/sync', headers,
      payload: { cities: [cities[0].id, 'TEST_UNKNOWN_REGION'], sources: ['kopis'], from: '2026-10-01', to: '2026-10-31' } });
    assert.equal(invalid.statusCode, 400); assert.equal(store.runs().length, 0);
    for (const route of ['/api/performances','/api/map']) {
      const valid = await app.inject(`${route}?${new URLSearchParams({ cities: cityCsv, q: 'x'.repeat(1000) })}`);
      assert.equal(valid.statusCode, 200);
      const tooLong = await app.inject(`${route}?${new URLSearchParams({ q: 'x'.repeat(1001) })}`);
      assert.equal(tooLong.statusCode, 400);
      const oversizedRegions = await app.inject(`${route}?${new URLSearchParams({ cities: 'x'.repeat(15001) })}`);
      assert.equal(oversizedRegions.statusCode, 400);
    }
  } finally { await app.close(); store.close(); }
});
