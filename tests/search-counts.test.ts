import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/store.js';
import { NATIONAL_CITIES } from '../server/providers/cities.js';
import type { PerformanceInput, SearchFilters } from '../shared/types.js';

const record = (id: number, changes: Partial<PerformanceInput> = {}): PerformanceInput => ({
  source: 'kopis', sourceId: `TEST_COUNTS_${id}`, title: `TEST counts ${id}`, cityId: 'andong', startDate: '2026-10-01', endDate: '2026-10-31',
  genre: '음악', sourceGenre: '', venue: 'TEST venue', address: '', poster: '', sourceUrl: '', price: '', priceType: 'unknown', age: '',
  runtime: '', cast: '', producer: '', organizer: '', contact: '', schedule: '', description: '', status: '', detailState: 'complete',
  classification: 'performance', reviewReason: '', raw: null, ...changes,
});

test('search metadata counts pending detail before price and age while preserving empty, unknown and bookmarked groups', t => {
  const store = new Store(':memory:', NATIONAL_CITIES);
  t.after(() => store.close());
  const rows: { data: PerformanceInput; bookmarked: boolean }[] = [];
  const prices = ['free', 'paid', 'unknown', null, undefined] as const;
  const ages = ['8세 이상', '전체 관람', '', null, undefined] as const;
  store.transaction(() => {
    for (let index = 0; index < 60; index++) {
      const data = record(index, { source: index % 3 ? 'kopis' : 'culture', cityId: index % 4 ? 'andong' : 'yeosu',
        title: `TEST ${index % 2 ? 'Selected' : 'Other'} ${index}`, genre: index % 2 ? '음악' : '연극',
        detailState: index % 4 === 0 ? 'pending' : index % 4 === 1 ? 'failed' : 'complete',
        priceType: prices[index % prices.length] as any, age: ages[(index * 3) % ages.length] as any,
        classification: index === 59 ? 'excluded' : 'performance' });
      const id = store.upsert(data), bookmarked = index % 3 === 0;
      if (bookmarked) store.bookmark(id, true);
      rows.push({ data, bookmarked });
    }
    // Historical data can contain a source outside the current UI enum. Its positive count is retained,
    // but a group with no admission matches must not appear as a new zero-valued metadata property.
    const unknown = record(60, { source: 'historical' as any, priceType: 'paid', age: '8세 이상' });
    store.upsert(unknown); rows.push({ data: unknown, bookmarked: false });
    for (const city of ['andong', 'yeosu']) for (const source of ['kopis', 'culture'] as const) {
      const run = store.createRun(source, city, '2026-10-01', '2026-10-31'); store.setRunState(run, 'complete');
    }
  });
  store.db.exec('PRAGMA query_only=ON');
  const base: SearchFilters = { cities: 'andong,yeosu', from: '2026-10-01', to: '2026-10-31' };
  const selections: SearchFilters[] = [{}, { cities: 'andong' }, { cities: 'yeosu' }, { cities: 'unknown' },
    { source: 'kopis' }, { source: 'culture' }, { bookmarked: 'true' }, { q: 'Selected' }, { genre: '음악' }];
  const admissions: SearchFilters[] = [{}, { price: 'free' }, { price: 'paid' }, { price: 'unknown' },
    { age: '8세' }, { age: '전체' }, { age: 'absent' }, { price: 'free', age: '8세' }, { price: 'paid', age: '8세' }];
  for (const selection of selections) for (const admission of admissions) {
    const filters = { ...base, ...selection, ...admission };
    const selectedCities = filters.cities!.split(',');
    const selected = rows.filter(({ data, bookmarked }) => data.classification === 'performance'
      && selectedCities.includes(data.cityId) && (!filters.source || data.source === filters.source)
      && (filters.bookmarked !== 'true' || bookmarked) && (!filters.genre || data.genre === filters.genre)
      && (!filters.q || `${data.title} ${data.venue}`.toLowerCase().includes(filters.q.toLowerCase())));
    const pendingDetails = selected.filter(({ data }) => data.detailState !== 'complete').length;
    const matching = selected.filter(({ data }) => (!filters.price || data.detailState === 'complete' && data.priceType === filters.price)
      && (!filters.age || data.detailState === 'complete' && typeof data.age === 'string' && data.age.includes(filters.age)));
    const sourceCounts: Record<string, number> = { kopis: 0, culture: 0 };
    for (const { data } of matching) sourceCounts[data.source] = (sourceCounts[data.source] || 0) + 1;
    const expectedPartial = selectedCities.includes('unknown') || !!(filters.price || filters.age) && pendingDetails > 0;
    for (const result of [store.search(filters), store.searchMap(filters)]) {
      assert.equal(result.pendingDetails, pendingDetails, JSON.stringify(filters));
      assert.deepEqual(result.sourceCounts, sourceCounts, JSON.stringify(filters));
      assert.equal(result.total, sourceCounts.kopis + sourceCounts.culture, JSON.stringify(filters));
      assert.equal(result.partial, expectedPartial, JSON.stringify(filters));
    }
  }
});
