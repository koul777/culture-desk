import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildingHeight, matchVenueBuilding, VenueBuildingService } from '../server/venue-buildings.js';
import verifiedSeed from '../server/venue-building-seed.json' with { type: 'json' };

const venue = { id: 101, venue: '테스트문화예술의전당 (대극장)', latitude: 37.5, longitude: 127, locationPrecision: 'venue' as const };
const ring = (west = 126.9998, south = 37.4998, east = 127.0002, north = 37.5002) => [
  { lon: west, lat: south }, { lon: east, lat: south }, { lon: east, lat: north }, { lon: west, lat: north }, { lon: west, lat: south },
];
const way = (id = 1, tags: Record<string, string> = {}, geometry = ring()) => ({ type: 'way', id, tags: { building: 'yes', ...tags }, geometry });
const json = (elements: unknown[]) => new Response(JSON.stringify({ elements }), { headers: { 'content-type': 'application/json' } });

test('accepts an actual containing footprint with explicit name and height evidence', () => {
  const result = matchVenueBuilding(venue, { elements: [way(1, { name: '테스트문화예술의전당', height: '14.5 m' })] });
  assert.equal(result.status, 'available'); assert.equal(result.building?.type, 'Polygon');
  assert.equal(result.building?.confidence, 'coordinate_and_name'); assert.equal(result.building?.heightMeters, 14.5);
  assert.equal(result.building?.heightSource, 'tag'); assert.equal(result.building?.estimatedHeight, false);
  assert.equal(result.building?.sourceUrl, 'https://www.openstreetmap.org/way/1');
  assert.deepEqual(result.building?.coordinates[0][0], [126.9998, 37.4998]);
});

test('unnamed containing building is labeled coordinate association, without inventing height', () => {
  const result = matchVenueBuilding(venue, { elements: [way()] });
  assert.equal(result.building?.confidence, 'coordinate');
  assert.equal(result.building?.heightMeters, null); assert.equal(result.building?.heightSource, 'unknown');
});

test('does not substitute city centres, unrelated adjacent buildings or conflicting named buildings', () => {
  assert.equal(matchVenueBuilding({ ...venue, locationPrecision: 'city' as 'venue' }, { elements: [way()] }).reason, 'no_venue_coordinates');
  assert.equal(matchVenueBuilding(venue, { elements: [way(1, {}, ring(127.0003, 37.4998, 127.0006, 37.5002))] }).reason, 'no_matching_building');
  assert.equal(matchVenueBuilding(venue, { elements: [way(1, { name: '다른 학교 체육관' })] }).reason, 'no_matching_building');
});

test('accepts a nearby named footprint only with matching identity within 120 metres', () => {
  const match = matchVenueBuilding(venue, { elements: [way(1, { name: '테스트문화예술의전당' }, ring(127.0003, 37.4998, 127.0006, 37.5002))] });
  assert.equal(match.building?.confidence, 'name_nearby'); assert.ok(match.building!.distanceMeters > 20 && match.building!.distanceMeters < 30);
  assert.equal(matchVenueBuilding(venue, { elements: [way(1, { name: '테스트문화예술의전당' }, ring(127.003, 37.4998, 127.004, 37.5002))] }).status, 'unavailable');
});

test('ambiguous overlaps, incomplete geometry, partial provider responses and malformed points are rejected', () => {
  assert.equal(matchVenueBuilding(venue, { elements: [way(1), way(2)] }).reason, 'ambiguous_match');
  assert.equal(matchVenueBuilding(venue, { elements: [way(1, {}, ring().slice(0, 4))] }).status, 'unavailable');
  assert.equal(matchVenueBuilding(venue, { elements: [way()], remark: 'runtime error: timeout' }).reason, 'upstream_unavailable');
  assert.equal(matchVenueBuilding(venue, { elements: [way(1, {}, [{ lon: NaN, lat: 37.5 }, ...ring()])] }).status, 'unavailable');
});

test('joins real relation member segments and preserves courtyard holes and multiple outer rings', () => {
  const outline = ring();
  const courtyard = ring(126.99995, 37.49995, 127.00005, 37.50005);
  const relation = { type: 'relation', id: 5, tags: { type: 'multipolygon', building: 'yes' }, members: [
    { type: 'way', ref: 1, role: 'outer', geometry: outline.slice(0, 3) },
    { type: 'way', ref: 2, role: 'outer', geometry: outline.slice(2) },
    { type: 'way', ref: 3, role: 'inner', geometry: courtyard },
    { type: 'way', ref: 4, role: 'outer', geometry: ring(127.0004, 37.4998, 127.0006, 37.5002) },
  ] };
  assert.equal(matchVenueBuilding(venue, { elements: [relation] }).status, 'unavailable', 'point in courtyard must not match');
  const result = matchVenueBuilding({ ...venue, latitude: 37.4999 }, { elements: [relation, way(1)] });
  assert.equal(result.building?.type, 'MultiPolygon'); assert.equal(result.building?.osmType, 'relation');
  assert.equal(result.building?.coordinates.length, 2); assert.equal(result.building?.coordinates[0].length, 2);
});

test('height units and floor estimates are explicit; malformed and implausible heights stay unknown', () => {
  assert.equal(buildingHeight({ height: '40 ft' }).heightMeters, 12.19);
  assert.equal(buildingHeight({ height: '40\'6"' }).heightMeters, 12.34);
  assert.deepEqual(buildingHeight({ 'building:levels': '4' }), { heightMeters: 12, heightSource: 'levels', estimatedHeight: true });
  const invalid: Record<string, string>[] = [{ height: '9000' }, { height: '-1' }, { height: '5;8' }, { 'building:levels': '2.5' }, {}];
  for (const tags of invalid) assert.equal(buildingHeight(tags).heightMeters, null);
});

test('verified public snapshots serve real venue geometry without a network dependency', async () => {
  const now = Math.max(...verifiedSeed.records.map(seed => Date.parse(seed.checkedAt))) + 1000;
  const service = new VenueBuildingService({ now: () => now, fetch: (async () => { throw new Error('Network intentionally disabled'); }) as typeof fetch });
  for (const [index, seed] of verifiedSeed.records.entries()) {
    const result = await service.lookup({ id: index + 1, venue: seed.venueName, latitude: seed.latitude, longitude: seed.longitude, locationPrecision: 'venue' });
    assert.equal(result.status, 'available'); assert.equal(result.checkedAt, seed.checkedAt);
    assert.equal(result.building?.confidence, 'coordinate_and_name');
    if (index === 0) {
      assert.equal(result.building?.osmId, 581720573); assert.equal(result.building?.heightMeters, 6);
      assert.equal(result.building?.heightSource, 'levels'); assert.equal(result.building?.estimatedHeight, true);
      assert.equal(result.building?.nameSourceUrl, 'https://www.openstreetmap.org/node/4633865071');
    } else assert.equal(result.building?.heightMeters, null);
  }
  const expired = new VenueBuildingService({ now: () => now + 31 * 86400000, endpoints: [], fetch: (async () => { throw new Error('Network intentionally disabled'); }) as typeof fetch });
  const seed = verifiedSeed.records[0];
  assert.equal((await expired.lookup({ id: 1, venue: seed.venueName, latitude: seed.latitude, longitude: seed.longitude, locationPrecision: 'venue' })).reason, 'upstream_unavailable');
});

test('service coalesces concurrent performances at one venue and caches by venue, not performance id', async () => {
  let calls = 0;
  const service = new VenueBuildingService({ endpoints: ['https://example.invalid/overpass'], fetch: (async (_url, init) => {
    calls++; assert.ok(init?.signal); return json([way()]);
  }) as typeof fetch });
  const results = await Promise.all([service.lookup(venue), service.lookup({ ...venue, id: 202 })]);
  assert.equal(calls, 1); assert.deepEqual(results.map(r => r.performanceId), [101, 202]);
  await service.lookup(venue); assert.equal(calls, 1);
  assert.equal((await service.lookup({ ...venue, locationPrecision: undefined })).reason, 'no_venue_coordinates'); assert.equal(calls, 1);
});

test('service handles quota cooldown, provider fallback and short negative-cache expiry', async () => {
  let now = 100000, calls = 0;
  const service = new VenueBuildingService({ now: () => now, endpoints: ['https://one.invalid', 'https://two.invalid'], fetch: (async () => {
    calls++; return new Response('', { status: 429 });
  }) as typeof fetch });
  assert.equal((await service.lookup(venue)).reason, 'upstream_unavailable'); assert.equal(calls, 2);
  await service.lookup(venue); await service.lookup({ ...venue, longitude: 127.01 }); assert.equal(calls, 2);
  now += 31000; await service.lookup(venue); assert.equal(calls, 4);
  let attempts = 0;
  const fallback = new VenueBuildingService({ endpoints: ['https://one.invalid', 'https://two.invalid'], fetch: (async () => ++attempts === 1 ? new Response('', { status: 503 }) : json([way()])) as typeof fetch });
  assert.equal((await fallback.lookup(venue)).status, 'available'); assert.equal(attempts, 2);
});

test('service refuses excessive response bodies and bounds simultaneous distinct venue lookups', async () => {
  const tooLarge = new VenueBuildingService({ endpoints: ['https://one.invalid'], fetch: (async () => new Response('{}', { headers: { 'content-length': String(3 * 1024 * 1024) } })) as typeof fetch });
  assert.equal((await tooLarge.lookup(venue)).reason, 'upstream_unavailable');
  const releases: (() => void)[] = [];
  const service = new VenueBuildingService({ endpoints: ['https://one.invalid'], fetch: (async () => {
    await new Promise<void>(resolve => releases.push(resolve)); return json([way()]);
  }) as typeof fetch });
  const first = service.lookup(venue), second = service.lookup({ ...venue, longitude: 127.001 });
  assert.equal((await service.lookup({ ...venue, longitude: 127.002 })).reason, 'busy');
  releases.forEach(resolve => resolve()); await Promise.all([first, second]);
});
