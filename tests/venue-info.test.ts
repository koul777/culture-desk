import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanVenueInfo, venueInfoFromSource } from '../server/venue-info.js';
import { hydrateReadonlySnapshot } from '../server/cloud/readonly-fallback.js';
import { Store } from '../server/store.js';
import { DEFAULT_CITIES } from '../server/providers/cities.js';
import { directionLinks } from '../web/lib/directions.js';
import type { PerformanceInput } from '../shared/types.js';

const raw = {
  mt20id: 'TEST1', relates: { relate: [
    { relatenm: '놀유니버스', relateurl: 'http://ticket.interpark.com/Ticket/Goods/GoodsInfo.asp?GoodsCode=1' },
    { relatenm: '중복', relateurl: 'http://ticket.interpark.com/Ticket/Goods/GoodsInfo.asp?GoodsCode=1' },
    { relatenm: '스크립트', relateurl: 'javascript:alert(1)' },
    { relatenm: '계정', relateurl: 'https://user:pass@example.test/' },
  ] },
  facility: {
    fcltynm: '예술의전당 [서울]', seatscale: '5000', relateurl: 'https://www.sac.or.kr', parkinglot: 'Y', elevbarrier: 'Y', cafe: 'N', telno: '02-0000-0000',
    mt13s: { mt13: [
      { prfplcnm: '오페라극장', seatscale: '2283', disabledseatscale: '12', stagearea: '' },
      { prfplcnm: '자유소극장', seatscale: '241', disabledseatscale: '' },
      { prfplcnm: '', seatscale: '10' },
    ] },
  },
};
const input = (changes: Partial<PerformanceInput> = {}): PerformanceInput => ({
  source: 'kopis', sourceId: 'TEST1', title: 'TEST 공연', cityId: 'andong', startDate: '2026-10-01', endDate: '2026-10-31', genre: '음악', sourceGenre: '',
  venue: '예술의전당 [서울] 오페라극장', address: '서울 서초구', poster: '', sourceUrl: '', price: '', priceType: 'unknown', age: '', runtime: '', cast: '',
  producer: '', organizer: '', contact: '', schedule: '', description: '', status: '', detailState: 'complete', classification: 'performance', reviewReason: '',
  latitude: 37.4786, longitude: 127.0118, locationPrecision: 'venue', raw, ...changes,
});

test('KOPIS facility payloads become whitelisted hall, amenity and booking facts with the performance hall marked', () => {
  const info = venueInfoFromSource(raw, '예술의전당 [서울] 오페라극장')!;
  assert.deepEqual(info, {
    facility: '예술의전당 [서울]', seats: 5000, homepage: 'https://www.sac.or.kr/', amenities: ['주차장', '장애인 엘리베이터'],
    halls: [{ name: '오페라극장', seats: 2283, disabledSeats: 12, current: true }, { name: '자유소극장', seats: 241 }],
    booking: [{ name: '놀유니버스', url: 'http://ticket.interpark.com/Ticket/Goods/GoodsInfo.asp?GoodsCode=1' }],
  });
  assert.ok(!JSON.stringify(info).includes('02-0000-0000'));
  assert.equal(venueInfoFromSource(raw, '예술의전당 [서울]')!.halls.some(hall => hall.current), false, 'a facility-only venue does not guess a hall');
  const single = venueInfoFromSource({ facility: { fcltynm: '동락관', mt13s: { mt13: { prfplcnm: '동락관', seatscale: '873' } } } }, '동락관')!;
  assert.deepEqual(single.halls, [{ name: '동락관', seats: 873, current: true }]);
  assert.equal(venueInfoFromSource({ mt20id: 'CULTURE' }, 'x'), undefined);
  assert.equal(venueInfoFromSource(null, 'x'), undefined);
});

test('stored venue facts are revalidated and unknown or unsafe values are dropped', () => {
  const info = cleanVenueInfo({ facility: 'A', halls: [{ name: 'B', seats: -1, extra: 'x' }], amenities: ['주차장', '<b>임의</b>'],
    homepage: 'ftp://example.test', booking: [{ name: 'C', url: 'https://example.test/c' }], private: 'TEST_PRIVATE' }, 'A B')!;
  assert.deepEqual(info, { facility: 'A', halls: [{ name: 'B', current: true }], amenities: ['주차장'], booking: [{ name: 'C', url: 'https://example.test/c' }] });
  assert.equal(cleanVenueInfo({ facility: 'A', halls: [], amenities: [], booking: [] }, 'A'), undefined);
  assert.equal(cleanVenueInfo('text', 'A'), undefined);
});

test('details include venue facts from stored provider data while search and map rows keep their previous shape', t => {
  const store = new Store(':memory:', DEFAULT_CITIES); t.after(() => store.close());
  const id = store.upsert(input());
  assert.equal(store.item(id)!.venueInfo!.halls[0].current, true);
  assert.equal(store.search({}).items[0].venueInfo, undefined);
  const plain = store.upsert(input({ sourceId: 'TEST2', raw: null }));
  assert.equal(store.item(plain)!.venueInfo, undefined);
});

test('a daily list refresh keeps the stored detail payload so venue facts do not disappear', t => {
  const store = new Store(':memory:', DEFAULT_CITIES); t.after(() => store.close());
  const id = store.upsert(input());
  store.upsert(input({ detailState: 'pending', status: '공연중', raw: { mt20id: 'TEST1', prfstate: '공연중' } }));
  assert.equal(store.item(id)!.status, '공연중');
  assert.equal(store.item(id)!.venueInfo!.halls.length, 2);
  assert.ok((store.internal('kopis', 'TEST1')!.raw as any).facility);
  store.upsert(input({ raw: { mt20id: 'TEST1' } }));
  assert.equal(store.item(id)!.venueInfo, undefined, 'a newer detail payload still replaces the old one');
});

test('the read-only fallback serves pre-derived venue facts only after revalidation', () => {
  const venueInfo = { ...venueInfoFromSource(raw, '예술의전당 [서울] 오페라극장')!, private: 'TEST_PRIVATE' };
  const model = hydrateReadonlySnapshot({ version: 1, snapshotAt: '2026-10-16T11:19:02.370Z', performances: [{
    ...input(), id: 7, updatedAt: '2026-10-16T10:00:00.000Z', venueInfo,
  } as any] });
  try {
    const item = model.store.item(7)!;
    assert.equal(item.venueInfo!.halls.length, 2);assert.equal(item.venueInfo!.booking.length, 1);
    assert.ok(!JSON.stringify(item).includes('TEST_PRIVATE'));
    assert.equal(model.store.search({}).items[0].venueInfo, undefined);
  } finally { model.store.close(); }
});

test('direction links use exact venue coordinates when known and a place search otherwise, never the visitor location', () => {
  const precise = directionLinks({ venue: '예술의전당, 오페라극장', address: '', latitude: 37.4786, longitude: 127.0118, locationPrecision: 'venue' })!;
  assert.equal(precise.kakao, `https://map.kakao.com/link/to/${encodeURIComponent('예술의전당  오페라극장')},37.478600,127.011800`);
  assert.equal(precise.naver, `https://map.naver.com/p/search/${encodeURIComponent('예술의전당, 오페라극장')}`);
  assert.equal(directionLinks({ venue: '청주예술의전당 (대공연장)', address: '' })!.naver, `https://map.naver.com/p/search/${encodeURIComponent('청주예술의전당')}`);
  assert.equal(directionLinks({ venue: '예술의전당 [서울] 오페라극장', address: '' })!.naver, `https://map.naver.com/p/search/${encodeURIComponent('예술의전당 서울 오페라극장')}`);
  const city = directionLinks({ venue: '특설무대', address: '경상북도 안동시 경동로 684', latitude: 36.56, longitude: 128.72, locationPrecision: 'city' })!;
  assert.equal(city.precise, false);
  assert.equal(city.kakao, `https://map.kakao.com/link/search/${encodeURIComponent('경상북도 안동시 경동로 684')}`);
  assert.equal(directionLinks({ venue: ' ', address: '' }), null);
});
