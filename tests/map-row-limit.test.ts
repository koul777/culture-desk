import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Store } from '../server/store.js';
import { NATIONAL_CITIES } from '../server/providers/cities.js';
import { buildMapResult } from '../server/map-response.js';
import { MAP_CTE_MIN_ROWS, MAP_MAX_BYTES, MAP_MAX_ITEMS, MAP_QUERY_ROWS } from '../server/map-limits.js';
import type { PerformanceInput, SearchFilters } from '../shared/types.js';

const record = (id: number): PerformanceInput => ({
  source: 'kopis', sourceId: `TEST_LIMIT_${id}`, cityId: 'andong', title: `TEST ${id}`, venue: 'TEST venue',
  startDate: '2026-10-01', endDate: '2026-10-31', genre: '음악', sourceGenre: '', address: '', poster: '', sourceUrl: '',
  price: 'TEST free', priceType: 'free', age: '전체', runtime: '', cast: '', producer: '', organizer: '', contact: '', schedule: '',
  description: 'TEST details', status: '', detailState: 'complete', classification: 'performance', reviewReason: '', raw: null,
});
function fixture(t: TestContext) {
  const store = new Store(':memory:', NATIONAL_CITIES.filter(city => city.id === 'andong'));
  t.after(() => store.close());
  return store;
}
const fixed = (result: ReturnType<Store['searchMap']>) => ({ ...result, snapshotAt: '2026-10-19T00:00:00.000Z' });
function compare(store: Store, filters: SearchFilters, selected: number) {
  const map = store.searchMap(filters), all = store.search(filters, true);
  assert.equal(all.items.length, selected, 'ordinary all-row search used by export stays unbounded');
  assert.equal(map.items.length, selected >= MAP_CTE_MIN_ROWS ? MAP_QUERY_ROWS : selected, 'large maps retain one sentinel row; smaller selections keep the original plan');
  const result = buildMapResult(fixed(map));
  const wire = JSON.stringify(result);
  assert.equal(wire, JSON.stringify(buildMapResult(fixed(all))), 'exact legacy marker bytes and metadata');
  assert.equal(result.truncated, result.items.length < selected, 'truncation uses selected rows, not known-source total');
  assert.ok(result.items.length <= MAP_MAX_ITEMS && Buffer.byteLength(wire) <= MAP_MAX_BYTES);
  assert.equal(store.db.prepare('PRAGMA query_only').get()!.query_only, 1);
  return { map, all, result: JSON.parse(wire) as typeof result };
}

test('map query preserves marker/sentinel and 20001/20002/20003 optimization boundaries while paged/all search stays unchanged', t => {
  const store = fixture(t);
  const insert = store.db.prepare(`INSERT INTO performances(id,source,source_id,city_id,start_date,end_date,classification,detail_state,data,updated_at)
    VALUES(?,'kopis',?,'andong','2026-10-01','2026-10-31','performance','complete',?,'2026-10-01T00:00:00.000Z')`);
  let count = 0;
  for (const target of [0, MAP_MAX_ITEMS - 1, MAP_MAX_ITEMS, MAP_QUERY_ROWS, MAP_QUERY_ROWS + 1,
    MAP_CTE_MIN_ROWS - 1, MAP_CTE_MIN_ROWS, MAP_CTE_MIN_ROWS + 1]) {
    store.db.exec('PRAGMA query_only=OFF');
    store.transaction(() => {
      while (count < target) { const row = record(++count); insert.run(count, row.sourceId, JSON.stringify(row)); }
    });
    store.db.exec('PRAGMA query_only=ON');
    const { map, result } = compare(store, { page: '2', limit: '1' }, target);
    assert.equal(map.total, target);
    assert.deepEqual(result.items.map(row => row.id), Array.from({ length: Math.min(target, MAP_MAX_ITEMS) }, (_, index) => target - index));
    const page = store.search({ page: '2', limit: '1' });
    assert.equal(page.items.length, Math.min(target, 1));
    if (target) assert.equal(page.items[0].id, target - 1);
  }
});

test('map cap preserves positive bookmarks, historical counts, coverage, sparse/null markers and early byte truncation', t => {
  const store = fixture(t);
  const lastBookmarked = MAP_CTE_MIN_ROWS + 3;
  const insert = store.db.prepare(`INSERT INTO performances(id,source,source_id,city_id,start_date,end_date,classification,detail_state,data,updated_at)
    VALUES(?,?,?,'andong','2026-10-01','2026-10-31','performance',?,?,'2026-10-01T00:00:00.000Z')`);
  const bookmark = store.db.prepare("INSERT INTO bookmarks VALUES(?,'TEST private note','2026-10-01T00:00:00.000Z')");
  store.transaction(() => {
    for (let id = 1; id <= lastBookmarked + 1; id++) {
      const source = id === 1 ? 'kopis' : 'historical';
      const row: Record<string, unknown> = { ...record(id), source, detailState: id === 2 ? 'pending' : 'complete' };
      if (id === 3) row.priceType = 'paid';
      if (id === 4) row.age = '8세';
      if (id === lastBookmarked) { for (const key of Object.keys(row)) if (key !== 'title') delete row[key]; }
      if (id === lastBookmarked - 1) Object.assign(row, { latitude: null, longitude: null, locationPrecision: null });
      insert.run(id, source, `TEST_LIMIT_${id}`, id === 2 ? 'pending' : 'complete', JSON.stringify(row));
      if (id <= lastBookmarked) bookmark.run(id);
    }
    for (const source of ['kopis', 'culture'] as const) store.setRunState(store.createRun(source, 'andong', '2026-10-01', '2026-10-31'), 'complete');
    store.setRunState(store.createRun('culture', 'andong', '2026-10-01', '2026-10-31'), 'partial');
  });
  store.db.exec('PRAGMA query_only=ON');
  const filters: SearchFilters = { bookmarked: 'true', cities: 'andong', from: '2026-10-01', to: '2026-10-31' };
  const { map, result } = compare(store, filters, lastBookmarked);
  assert.equal(map.total, 1, 'public total retains its historical known-source-only contract');
  assert.deepEqual(map.sourceCounts, { kopis: 1, culture: 0, historical: lastBookmarked - 1 });
  assert.equal(map.pendingDetails, 1); assert.equal(map.partial, true, 'newer incomplete coverage remains disclosed');
  assert.deepEqual(result.items[0], { id: lastBookmarked, title: `TEST ${lastBookmarked}` });
  assert.equal(result.items[1].latitude, null); assert.equal(result.items[1].longitude, null);
  assert.equal(Object.hasOwn(result.items[0], 'latitude'), false);
  for (const marker of result.items) assert.equal(Object.hasOwn(marker, 'note'), false);
  for (const { admission, rows } of [
    { admission: { price: 'free' }, rows: MAP_CTE_MIN_ROWS },
    { admission: { price: 'free', age: '전체' }, rows: MAP_CTE_MIN_ROWS - 1 },
  ] as const) {
    const selected = compare(store, { ...filters, ...admission }, rows);
    assert.equal(selected.map.pendingDetails, 1, 'pending metadata precedes admission predicates');
    assert.equal(selected.map.total, 1);
  }
  // More than the row cap still selects the same complete UTF-8 prefix when the
  // byte budget becomes the earlier limit. No public artifact is mutated.
  store.db.exec('PRAGMA query_only=OFF');
  const read = store.db.prepare('SELECT data FROM performances WHERE id=?');
  const write = store.db.prepare('UPDATE performances SET data=? WHERE id=?');
  store.transaction(() => {
    for (let id = lastBookmarked; id > lastBookmarked - 6; id--) {
      const row = JSON.parse(String(read.get(id)!.data));
      row.title = '가'.repeat(160000); row.venue = '나'.repeat(160000);
      write.run(JSON.stringify(row), id);
    }
  });
  store.db.exec('PRAGMA query_only=ON');
  const bounded = compare(store, filters, lastBookmarked).result;
  assert.equal(bounded.items.length, 3); assert.equal(bounded.truncated, true);
  assert.deepEqual(bounded.items.map(row => row.id), [lastBookmarked, lastBookmarked - 1, lastBookmarked - 2]);
});
