import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MapPerformance } from '../shared/types.js';
import { groupVenueCoordinates } from '../web/lib/map-data.js';

const item = (id: number, latitude: number, longitude: number): MapPerformance => ({
  id, title: `TEST ${id}`, venue: `TEST venue ${id}`, cityId: 'andong', source: 'kopis',
  startDate: '2026-10-01', endDate: '2026-11-01', latitude, longitude, locationPrecision: 'venue',
});

test('venue grouping preserves every id and source order while using the existing five-decimal coordinate precision', () => {
  const first = item(1, 36.123451, 128.123451);
  const nearby = item(2, 36.123452, 128.123452);
  const separate = item(3, 36.12346, 128.12346);
  const same = item(4, 36.123451, 128.123451);
  const rows = [first, separate, nearby, same];
  const groups = groupVenueCoordinates(rows);
  assert.deepEqual(groups.map(group => group.map(row => row.id)), [[1, 2, 4], [3]]);
  assert.deepEqual(new Set(groups.flat().map(row => row.id)), new Set(rows.map(row => row.id)));
  assert.equal(groups.flat().length, rows.length);
  assert.equal(groups[0][0], first);
  assert.deepEqual(rows, [first, separate, nearby, same]);
});

test('venue grouping supports an empty map and many performances at the same venue without truncating popup membership', () => {
  assert.deepEqual(groupVenueCoordinates([]), []);
  const rows = Array.from({ length: 1200 }, (_, index) => item(index, 37.5, 127.2));
  const groups = groupVenueCoordinates(rows);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map(row => row.id), rows.map(row => row.id));
});
