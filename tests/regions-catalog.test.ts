import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CITIES, NATIONAL_CITIES } from '../server/providers/cities.js';
import { NATIONAL_REGION_CATALOG } from '../server/providers/national-cities.js';
import { cultureRegionParams, provinceShortName, resolveCityId } from '../server/providers/classify.js';
import { createCultureProvider } from '../server/providers/culture.js';

test('national catalog includes the 230 current KOPIS municipalities with unique stable identifiers', () => {
  assert.equal(NATIONAL_CITIES.length, 230);
  assert.equal(new Set(NATIONAL_CITIES.map(city => city.sido)).size, 16);
  assert.equal(new Set(NATIONAL_CITIES.map(city => city.id)).size, 230);
  assert.equal(new Set(NATIONAL_CITIES.map(city => city.kopisSigungu)).size, 230);
  for (const city of NATIONAL_CITIES) {
    assert.match(city.kopisSido, /^\d{2}$/); assert.match(city.kopisSigungu, /^\d{4}$/);
    assert.ok(city.kopisSigungu.startsWith(city.kopisSido));
    assert.ok(city.sigungu.length > 0 && city.sido.length > 0 && city.name.length > 0);
    assert.notEqual(provinceShortName(city.sido), city.sido);
    if (!DEFAULT_CITIES.some(seed => seed.id === city.id)) assert.equal(city.id, `region-${city.kopisSigungu}`);
  }
});

test('the original seven cities keep IDs, region codes, names and approximate centres', () => {
  assert.equal(DEFAULT_CITIES.length, 7);
  for (const seed of DEFAULT_CITIES) {
    const current = NATIONAL_CITIES.find(city => city.id === seed.id)!;
    for (const key of ['name','sido','sigungu','kopisSido','kopisSigungu','latitude','longitude'] as const) assert.equal(current[key], seed[key]);
    for (const alias of seed.aliases) assert.ok(current.aliases.includes(alias));
  }
  assert.ok(NATIONAL_REGION_CATALOG.every(city => city.latitude === undefined && city.longitude === undefined));
});

test('catalog uses live merged and renamed regions rather than obsolete PDF codes', () => {
  const byCode = (code: string) => NATIONAL_CITIES.find(city => city.kopisSigungu === code);
  assert.equal(byCode('1230')?.sigungu, '북구'); assert.equal(byCode('1233')?.sigungu, '광산구');
  assert.equal(byCode('1213')?.id, 'yeosu'); assert.equal(byCode('1215')?.id, 'suncheon');
  assert.equal(byCode('5211')?.sido, '전북특별자치도'); assert.equal(byCode('2772')?.sigungu, '군위군');
  assert.equal(byCode('2812')?.sigungu, '제물포구'); assert.equal(byCode('2815')?.sigungu, '영종구');
  assert.equal(byCode('2827')?.sigungu, '서해구'); assert.equal(byCode('2829')?.sigungu, '검단구');
  assert.equal(byCode('4167')?.sigungu, '여주시'); assert.equal(byCode('4399')?.sigungu, '증평군');
  assert.ok(NATIONAL_CITIES.every(city => !['29','45','46'].includes(city.kopisSido)));
  for (const code of ['2811','2814','2826','4173','4371','4772']) assert.equal(byCode(code), undefined);
});

test('same district names remain distinct by province, and Gyeonggi Gwangju is separate', () => {
  const district = NATIONAL_CITIES.filter(city => city.sigungu === '중구');
  assert.ok(district.length > 1); assert.equal(new Set(district.map(city => city.id)).size, district.length);
  const gyeonggi = NATIONAL_CITIES.find(city => city.kopisSigungu === '4161')!;
  const merged = NATIONAL_CITIES.find(city => city.kopisSigungu === '1230')!;
  assert.deepEqual(cultureRegionParams(gyeonggi), { sido: '경기', sigungu: '광주시' });
  assert.deepEqual(cultureRegionParams(merged), { sido: '광주', sigungu: '북구' });
});

test('Sejong requests the entire province and recognizes source subdivisions without accepting another province', () => {
  const city = NATIONAL_CITIES.find(city => city.kopisSigungu === '3611')!;
  assert.deepEqual(cultureRegionParams(city), { sido: '세종', sigungu: undefined });
  assert.equal(resolveCityId(city, { areaText: '세종', sigungu: '조치원읍' }).reviewReason, '');
  assert.equal(resolveCityId(city, { areaText: '세종', sigungu: '세종시' }).reviewReason, '');
  assert.notEqual(resolveCityId(city, { areaText: '충남', sigungu: '공주시' }).reviewReason, '');
  assert.notEqual(resolveCityId(city, { areaText: '충남', sigungu: '세종시' }).reviewReason, '');
});

test('Culture adapter omits Sejong sigungu and retains performances in its 읍 subdivisions', async () => {
  const city = NATIONAL_CITIES.find(city => city.kopisSigungu === '3611')!;
  let query: URLSearchParams | undefined;
  const provider = createCultureProvider('TEST_KEY', { fetch: async url => {
    query = new URL(url).searchParams;
    return new Response('<response><header><resultCode>00</resultCode></header><body><totalCount>1</totalCount><items><item><seq>TEST-1</seq><title>TEST 세종 공연</title><startDate>20261001</startDate><endDate>20261031</endDate><realmCode>A000</realmCode><realmName>연극</realmName><area>세종</area><sigungu>조치원읍</sigungu></item></items></body></response>');
  } });
  const result = await provider.list({ city, from: '2026-10-01', to: '2026-10-31', page: 1, pageSize: 100 });
  assert.equal(query?.get('sido'), '세종'); assert.equal(query?.has('sigungu'), false);
  assert.equal(result.items[0].classification, 'performance'); assert.equal(result.items[0].cityId, city.id);
});
