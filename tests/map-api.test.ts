import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { NATIONAL_CITIES } from '../server/providers/cities.js';
import type { PerformanceInput } from '../shared/types.js';

// In-memory TEST records only: no real user database, API keys or provider requests.
const performance = (id: number, changes: Partial<PerformanceInput> = {}): PerformanceInput => ({
  source: 'kopis', sourceId: `TEST-${id}`, title: `TEST 공연 ${id}`, cityId: 'andong',
  startDate: '2026-10-01', endDate: '2026-10-31', genre: '연극', sourceGenre: 'TEST 장르',
  venue: 'TEST 공연장', address: 'TEST 주소', poster: 'https://example.invalid/poster', sourceUrl: 'https://example.invalid/show',
  price: 'TEST 관람료', priceType: 'paid', age: 'TEST 연령', runtime: 'TEST 시간', cast: 'TEST 출연진',
  producer: 'TEST 제작', organizer: 'TEST 주관', contact: 'TEST 연락처', schedule: 'TEST 일정',
  description: 'TEST 설명', status: 'TEST 상태', detailState: 'complete', classification: 'performance',
  reviewReason: '', latitude: 36.568, longitude: 128.729, locationPrecision: 'venue', raw: { test: true }, ...changes,
});

async function fixture(t: TestContext) {
  const store = new Store(':memory:', NATIONAL_CITIES);
  const { app } = await createApp({ port: 4317, databasePath: ':memory:', keys: { kopis: '', culture: '' }, requestIntervalMs: 350, syncIntervalHours: 24 },
    { store, providers: {}, startWorker: false });
  t.after(async () => { await app.close(); store.close(); });
  return { store, app };
}

test('map omits unused and private fields entirely without changing stored details or notes', async t => {
  const { store, app } = await fixture(t);
  const original = performance(1, { description: 'TEST 긴 설명 '.repeat(10000), producer: 'TEST 제작 '.repeat(1000) });
  const id = store.upsert(original);
  const note = 'TEST 기획 메모 '.repeat(1500);
  store.bookmark(id, true, note);
  const response = await app.inject({ method: 'GET', url: '/api/map' });
  assert.equal(response.statusCode, 200);
  const result = response.json(); const item = result.items[0];
  assert.equal(result.total, 1); assert.equal(result.truncated, false);
  assert.deepEqual(Object.keys(item).sort(), ['id','title','venue','cityId','startDate','endDate','latitude','longitude','locationPrecision','source'].sort());
  for (const field of ['sourceId','sourceGenre','address','poster','sourceUrl','price','age','runtime','cast','producer','organizer','contact','schedule','description','status','reviewReason','note','updatedAt','bookmarked','genre','priceType','detailState','classification']) assert.equal(Object.hasOwn(item, field), false);
  for (const field of ['title','venue','cityId','startDate','endDate','latitude','longitude','locationPrecision'] as const) assert.equal(item[field], original[field]);
  assert.equal(item.id, id); assert.equal(item.source, original.source);
  assert.ok(response.rawPayload.byteLength < 2000);
  const detail = await app.inject({ method: 'GET', url: `/api/performances/${id}` });
  assert.equal(detail.json().description, original.description); assert.equal(detail.json().note, note);
  assert.deepEqual(store.internal('kopis', original.sourceId)?.raw, original.raw);
});

test('map caps rows at 10000 and keeps total/count metadata for all matches', async t => {
  const { store, app } = await fixture(t);
  store.transaction(() => { for (let n = 0; n < 10001; n++) store.upsert(performance(n)); });
  const response = await app.inject({ method: 'GET', url: '/api/map?limit=1&page=2' });
  const result = response.json();
  assert.equal(result.total, 10001); assert.equal(result.sourceCounts.kopis, 10001);
  assert.equal(result.items.length, 10000); assert.equal(result.truncated, true);
  assert.ok(response.rawPayload.byteLength <= 3 * 1024 * 1024);
});

test('all 5602 nationwide performances and every region fit within the 3 MiB map budget', async t => {
  const { store, app } = await fixture(t);
  const ids: number[] = [];
  store.transaction(() => {
    for (let n = 0; n < 5602; n++) {
      const city = NATIONAL_CITIES[n % NATIONAL_CITIES.length];
      ids.push(store.upsert(performance(n, { cityId: city.id, source: n % 4 ? 'kopis' : 'culture',
        title: `2026 전국 공연예술제 ${city.sido} ${city.name} · 가족과 함께하는 특별 공연 ${n}`,
        venue: `${city.name} 문화예술회관 대공연장`, description: 'TEST 상세 원문 '.repeat(300),
      })));
    }
  });
  const response = await app.inject('/api/map?from=2026-10-01&to=2027-01-16&limit=1&page=2');
  assert.equal(response.statusCode, 200);
  const result = response.json();
  assert.equal(result.total, 5602); assert.equal(result.items.length, 5602); assert.equal(result.truncated, false);
  assert.equal(result.sourceCounts.kopis + result.sourceCounts.culture, 5602);
  assert.deepEqual(new Set(result.items.map((item: { id: number }) => item.id)), new Set(ids));
  assert.deepEqual(new Set(result.items.map((item: { cityId: string }) => item.cityId)), new Set(NATIONAL_CITIES.map(city => city.id)));
  assert.ok(response.rawPayload.byteLength <= 3 * 1024 * 1024, `${response.rawPayload.byteLength} bytes exceeds map budget`);
});

test('map enforces the UTF-8 JSON budget without clipping Korean titles or venues', async t => {
  const { store, app } = await fixture(t);
  const title = '가'.repeat(160000); const venue = '나'.repeat(160000);
  store.transaction(() => { for (let n = 0; n < 6; n++) store.upsert(performance(n, { title, venue })); });
  const response = await app.inject({ method: 'GET', url: '/api/map' });
  const result = response.json();
  assert.equal(result.total, 6); assert.equal(result.truncated, true);
  assert.equal(result.items.length, 3);
  assert.ok(response.rawPayload.byteLength <= 3 * 1024 * 1024);
  for (const item of result.items) { assert.equal(item.title, title); assert.equal(item.venue, venue); }
});

test('map applies city, period, source, search and bookmark filters before projection', async t => {
  const { store, app } = await fixture(t);
  const wanted = store.upsert(performance(1, { title: 'TEST 선택 공연' })); store.bookmark(wanted, true, 'TEST retained');
  const bookmarked = (row: PerformanceInput) => store.bookmark(store.upsert(row), true, 'TEST');
  bookmarked(performance(2, { title: 'TEST 선택 공연', cityId: 'gangneung' }));
  bookmarked(performance(3, { title: 'TEST 선택 공연', startDate: '2026-11-01', endDate: '2026-11-02' }));
  bookmarked(performance(4, { title: 'TEST 선택 공연', source: 'culture' }));
  store.upsert(performance(5, { title: 'TEST 선택 공연' }));
  bookmarked(performance(6, { title: 'TEST 다른 공연' }));
  bookmarked(performance(7, { title: 'TEST 선택 전시', classification: 'excluded' }));
  const query = new URLSearchParams({ cities: 'andong', from: '2026-10-15', to: '2026-10-16', source: 'kopis', q: '선택', bookmarked: 'true' });
  const response = await app.inject({ method: 'GET', url: `/api/map?${query}` });
  const result = response.json();
  assert.equal(response.statusCode, 200); assert.equal(result.total, 1); assert.equal(result.items[0].id, wanted);
  assert.equal(Object.hasOwn(result.items[0], 'note'), false); assert.equal(Object.hasOwn(result.items[0], 'bookmarked'), false); assert.equal(result.truncated, false);
  assert.deepEqual(result.sourceCounts, { kopis: 1, culture: 0 });
});
