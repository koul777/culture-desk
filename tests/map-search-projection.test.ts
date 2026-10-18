import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/store.js';
import { NATIONAL_CITIES } from '../server/providers/cities.js';
import { buildMapResult } from '../server/map-response.js';
import type { PerformanceInput, SearchFilters } from '../shared/types.js';

const record = (id: number, changes: Partial<PerformanceInput> = {}): PerformanceInput => ({
  source: 'kopis', sourceId: `TEST_MAP_${id}`, title: `TEST 공연 ${id}`, cityId: 'andong', startDate: '2026-10-01', endDate: '2026-10-31',
  genre: '음악', sourceGenre: '', venue: 'TEST 극장', address: '', poster: '', sourceUrl: '', price: '', priceType: 'unknown', age: '',
  runtime: '', cast: '', producer: '', organizer: '', contact: '', schedule: '', description: 'TEST detail '.repeat(100), status: '',
  detailState: 'complete', classification: 'performance', reviewReason: '', latitude: 36.123456789012344,
  longitude: 128.12345678901235, locationPrecision: 'venue', raw: null, ...changes,
});
const stable = (result: Parameters<typeof buildMapResult>[0]) => JSON.stringify({ ...buildMapResult(result), snapshotAt: '<per-read>' });

test('compact map query preserves legacy marker bytes, filters, ordering and result metadata', t => {
  const store = new Store(':memory:', NATIONAL_CITIES);
  t.after(() => store.close());
  store.transaction(() => {
    for (let id = 1; id <= 18; id++) {
      const key = store.upsert(record(id, { source: id % 3 ? 'kopis' : 'culture', cityId: id % 4 ? 'andong' : 'yeosu',
        title: id % 2 ? `TEST 선택 공연 ${id}` : `TEST "따옴표" \\ 줄바꿈\n🎭 ${id}`, genre: id % 2 ? '연극' : '음악',
        priceType: id % 3 ? 'paid' : 'free', age: id % 2 ? '전체 관람' : '8세 이상', detailState: id % 5 ? 'complete' : 'pending',
        startDate: id % 7 ? '2026-10-01' : '2026-09-01', endDate: id % 7 ? '2026-10-31' : '2026-09-30',
        classification: id === 18 ? 'excluded' : 'performance' }));
      if (id % 3) store.bookmark(key, true, 'TEST private note');
    }
    const run = store.createRun('kopis', 'andong', '2026-10-01', '2026-10-31');
    store.setRunState(run, 'complete');
  });
  store.db.exec('PRAGMA query_only=ON');
  const filters: SearchFilters[] = [
    {}, { cities: 'andong' }, { cities: 'yeosu' }, { cities: 'andong,yeosu,andong' }, { cities: 'unknown' }, { cities: ',,' },
    { source: 'kopis' }, { source: 'culture' }, { q: '선택' }, { q: '%' }, { q: '따옴표' },
    { genre: '연극' }, { genre: 'unknown' }, { price: 'free' }, { price: 'paid' }, { price: 'unknown' },
    { age: '전체' }, { age: '8세', price: 'paid' }, { bookmarked: 'true' }, { bookmarked: 'false' },
    { page: '2', limit: '1' }, { page: '999', limit: '100' }, { status: 'ended' }, { status: 'ongoing' }, { status: 'upcoming' },
    { from: '2026-10-31', to: '2026-10-31', cities: 'andong', source: 'kopis' },
    { from: '2026-09-01', to: '2026-09-30', source: 'culture' },
  ];
  for (const filter of filters) assert.equal(stable(store.searchMap(filter)), stable(store.search(filter, true)), JSON.stringify(filter));
  assert.equal(store.db.prepare('PRAGMA query_only').get()!.query_only, 1);
});

test('compact projection distinguishes missing fields from null and keeps exact numbers and database IDs', t => {
  const store = new Store(':memory:', NATIONAL_CITIES);
  t.after(() => store.close());
  const precise = store.upsert(record(1));
  const absent = store.upsert(record(2, { latitude: undefined, longitude: undefined, locationPrecision: undefined }));
  const explicitNull = store.upsert(record(3));
  const sparse = store.upsert(record(4));
  const mismatched = store.upsert(record(5));
  const replace = (id: number, data: unknown) => store.db.prepare('UPDATE performances SET data=? WHERE id=?').run(JSON.stringify(data), id);
  replace(explicitNull, { ...record(3), latitude: null, longitude: null, locationPrecision: null });
  replace(sparse, { title: 'TEST sparse historical row' });
  replace(mismatched, { ...record(5), id: 999999, source: 'culture', cityId: 'yeosu', startDate: '2026-09-01' });
  const legacy = store.search({}, true);
  const compact = store.searchMap({});
  assert.equal(stable(compact), stable(legacy));
  const markers = new Map(JSON.parse(stable(compact)).items.map((item: any) => [item.id, item] as const));
  assert.equal((markers.get(precise) as any).latitude, record(1).latitude);
  assert.equal((markers.get(precise) as any).longitude, record(1).longitude);
  assert.equal(Object.hasOwn(markers.get(absent) as object, 'latitude'), false);
  assert.equal((markers.get(explicitNull) as any).latitude, null);
  assert.deepEqual(markers.get(sparse), { id: sparse, title: 'TEST sparse historical row' });
  assert.equal((markers.get(mismatched) as any).source, 'culture', 'source remains sourced from stored JSON as before');
  assert.equal((markers.get(mismatched) as any).id, mismatched, 'ID remains authoritative from the database');
});

test('compact projection preserves serialized IEEE precision, exponent forms, subnormals and signed zero', t => {
  const store = new Store(':memory:', NATIONAL_CITIES);
  t.after(() => store.close());
  const values = [33, 33 + Number.EPSILON * 32, 39 - Number.EPSILON * 32, 36.123456789012344,
    128.12345678901235, 1.0000000000000002, Number.MIN_VALUE, Number.MAX_VALUE, -Number.MIN_VALUE,
    -Number.MAX_VALUE, 1e-100, 1e100, Math.PI, 0, -0];
  for (const [index, value] of values.entries()) store.upsert(record(index, { latitude: value, longitude: value }));
  assert.equal(stable(store.searchMap({})), stable(store.search({}, true)), 'marker wire values must match exactly, without tolerance');
});
