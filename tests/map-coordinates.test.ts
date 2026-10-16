import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PerformanceInput } from '../shared/types.js';
import { Store } from '../server/store.js';
import { DEFAULT_CITIES } from '../server/providers/cities.js';
import { venueCoordinates } from '../server/providers/coordinates.js';
import { createCultureProvider } from '../server/providers/culture.js';
import { createKopisProvider } from '../server/providers/kopis.js';
import { ProviderError } from '../server/providers/errors.js';

const andong = DEFAULT_CITIES.find(city => city.id === 'andong')!;
const input = (sourceId = 'PFTEST'): PerformanceInput => ({
  source: 'kopis', sourceId, title: 'TEST 공연', cityId: 'andong',
  startDate: '2026-10-01', endDate: '2026-10-31', genre: '음악', sourceGenre: '음악',
  venue: 'TEST 공연장', address: '', poster: '', sourceUrl: '', price: '', priceType: 'unknown',
  age: '', runtime: '', cast: '', producer: '', organizer: '', contact: '', schedule: '', description: '',
  status: '', detailState: 'pending', classification: 'performance', reviewReason: '', raw: {},
});
const detail = (id: string, facility = 'FC001') => `<dbs><db><mt20id>${id}</mt20id><mt10id>${facility}</mt10id>
  <prfnm>TEST 공연</prfnm><prfpdfrom>2026.10.01</prfpdfrom><prfpdto>2026.10.31</prfpdto>
  <genrenm>서양음악(클래식)</genrenm><fcltynm>TEST 공연장</fcltynm><area>경상북도</area></db></dbs>`;
const facility = `<dbs><db><mt10id>FC001</mt10id><la>36.568</la><lo>128.729</lo>
  <adres>경상북도 안동시 TEST 도로</adres><telno>054-000-0000</telno></db></dbs>`;
const cultureRow = (coordinates: string) => `<response><header><resultCode>00</resultCode></header><body>
  <items><item><seq>123</seq><title>TEST 음악회</title><startDate>20261001</startDate><endDate>20261031</endDate>
  <realmCode>C000</realmCode><realmName>음악</realmName><sigungu>안동시</sigungu><area>경북</area>
  ${coordinates}</item></items><totalCount>1</totalCount></body></response>`;

describe('source map coordinates', () => {
  it('accepts source decimal coordinates and rejects empty, non-finite, swapped or outside-Korea pairs', () => {
    assert.deepEqual(venueCoordinates('36.568', '128.729'), { latitude: 36.568, longitude: 128.729, locationPrecision: 'venue' });
    for (const pair of [[null, null], ['', '128.7'], [' ', '128.7'], [0, 0], [NaN, 128], ['NaN', 128],
      [Infinity, 128], [128.729, 36.568], [32.9, 128], [39.1, 128], [36, 123], [36, 133], [true, 128], [{}, 128]]) {
      assert.equal(venueCoordinates(...pair as [unknown, unknown]), undefined);
    }
  });

  it('maps Culture gpsY to latitude and gpsX to longitude in both list and detail', async () => {
    const provider = createCultureProvider('TEST_KEY', { fetch: async () => new Response(cultureRow('<gpsX>128.729</gpsX><gpsY>36.568</gpsY>')) });
    const list = await provider.list({ city: andong, from: '2026-10-01', to: '2026-10-31', page: 1, pageSize: 100 });
    const item = await provider.detail(list.items[0]);
    for (const row of [list.items[0], item]) {
      assert.equal(row.latitude, 36.568); assert.equal(row.longitude, 128.729); assert.equal(row.locationPrecision, 'venue');
    }
  });

  it('does not invent Culture venue locations when the source GPS is absent or invalid', async () => {
    for (const gps of ['', '<gpsX/><gpsY/>', '<gpsX>null</gpsX><gpsY>NaN</gpsY>', '<gpsX>36.568</gpsX><gpsY>128.729</gpsY>']) {
      const provider = createCultureProvider('TEST_KEY', { fetch: async () => new Response(cultureRow(gps)) });
      const list = await provider.list({ city: andong, from: '2026-10-01', to: '2026-10-31', page: 1, pageSize: 100 });
      const row = await provider.detail(list.items[0]);
      assert.equal(row.latitude, undefined); assert.equal(row.longitude, undefined); assert.equal(row.locationPrecision, undefined);
    }
  });

  it('hydrates KOPIS venue location/address and shares one facility request across concurrent details', async () => {
    let facilities = 0;
    const provider = createKopisProvider('TEST_KEY', { fetch: async url => {
      const path = new URL(url).pathname;
      if (path.includes('/prfplc/')) { facilities++; return new Response(facility); }
      return new Response(detail(path.split('/').at(-1)!));
    } });
    const items = await Promise.all([provider.detail(input('PFONE')), provider.detail(input('PFTWO'))]);
    await provider.detail(input('PFTHREE'));
    assert.equal(facilities, 1);
    for (const item of items) {
      assert.equal(item.latitude, 36.568); assert.equal(item.longitude, 128.729);
      assert.equal(item.locationPrecision, 'venue'); assert.equal(item.detailState, 'complete');
      assert.equal(item.address, '경상북도 안동시 TEST 도로');
      assert.equal(JSON.stringify(item).includes('TEST_KEY'), false);
    }
  });

  it('keeps KOPIS performance detail when optional facility lookup fails and briefly caches the failure', async () => {
    let facilities = 0;
    const provider = createKopisProvider('TEST_KEY', { fetch: async url => {
      const path = new URL(url).pathname;
      if (path.includes('/prfplc/')) { facilities++; return new Response('unavailable', { status: 503 }); }
      return new Response(detail(path.split('/').at(-1)!));
    } });
    for (const id of ['PFONE', 'PFTWO']) {
      const item = await provider.detail(input(id));
      assert.equal(item.detailState, 'complete'); assert.equal(item.latitude, undefined); assert.equal(item.address, '경상북도');
    }
    assert.equal(facilities, 1);
  });

  it('rejects mismatched facility identity without assigning another venue location', async () => {
    const provider = createKopisProvider('TEST_KEY', { fetch: async url => new Response(
      new URL(url).pathname.includes('/prfplc/') ? facility.replace('FC001', 'FC002') : detail('PFTEST')) });
    const item = await provider.detail(input());
    assert.equal(item.detailState, 'complete'); assert.equal(item.latitude, undefined);
  });

  it('propagates KOPIS facility authentication/quota errors so the worker stops that source', async () => {
    for (const [status, kind] of [[403, 'auth'], [429, 'quota']] as const) {
      const provider = createKopisProvider('TEST_KEY', { fetch: async url => new URL(url).pathname.includes('/prfplc/')
        ? new Response('unavailable', { status }) : new Response(detail('PFTEST')) });
      await assert.rejects(provider.detail(input()), error => error instanceof ProviderError && error.kind === kind);
    }
  });
});

describe('map data persistence', () => {
  it('fills centres for old seed cities while preserving user coordinates and custom cities', () => {
    const store = new Store(':memory:', DEFAULT_CITIES);
    try {
      const { latitude: _lat, longitude: _lng, ...old } = andong;
      store.db.prepare('UPDATE cities SET data=? WHERE id=?').run(JSON.stringify(old), old.id);
      assert.equal(store.cities().find(city => city.id === 'andong')?.latitude, andong.latitude);
      store.db.prepare('UPDATE cities SET data=? WHERE id=?').run(JSON.stringify({ ...old, latitude: 36.5, longitude: 128.7 }), old.id);
      assert.equal(store.cities().find(city => city.id === 'andong')?.latitude, 36.5);
      store.addCity({ ...old, id: 'custom', name: 'TEST 도시' });
      assert.equal(store.cities().find(city => city.id === 'custom')?.latitude, undefined);
    } finally { store.close(); }
  });

  it('preserves hydrated venue coordinates and user notes during a list refresh', () => {
    const store = new Store(':memory:', DEFAULT_CITIES);
    try {
      const id = store.upsert({ ...input(), detailState: 'complete', ...venueCoordinates(36.568, 128.729) });
      store.bookmark(id, true, 'TEST planning note');
      store.upsert({ ...input(), ...venueCoordinates(36.57, 128.73) });
      const item = store.item(id)!;
      assert.equal(item.latitude, 36.568); assert.equal(item.longitude, 128.729);
      assert.equal(item.locationPrecision, 'venue'); assert.equal(item.note, 'TEST planning note');
    } finally { store.close(); }
  });
});
