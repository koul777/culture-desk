import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildingCameraRange, venueHeightModel, zoomedDistance } from '../web/lib/venue-3d.js';

test('a missing footprint never produces a model; an unknown height stays unchanged while preview varies', () => {
  assert.equal(venueHeightModel(null, 40), null);
  const source = Object.freeze({ heightMeters: null, heightSource: 'unknown' as const, estimatedHeight: false });
  assert.equal(venueHeightModel(source)?.meters, 12);
  assert.equal(venueHeightModel(source, 36)?.meters, 36);
  assert.equal(venueHeightModel(source)?.kind, 'assumed');
  assert.equal(source.heightMeters, null);
  assert.equal(venueHeightModel(source, 1000)?.meters, 80);
  assert.equal(venueHeightModel(source, NaN)?.meters, 12);
});

test('source-recorded and floor-estimated heights retain their provenance and ignore preview changes', () => {
  assert.deepEqual(venueHeightModel({ heightMeters: 27, heightSource: 'tag', estimatedHeight: false }, 80), { kind: 'provided', meters: 27, label: '기록 높이 모형' });
  assert.equal(venueHeightModel({ heightMeters: 6, heightSource: 'levels', estimatedHeight: true }, 80)?.kind, 'levels');
  assert.equal(venueHeightModel({ heightMeters: 6, heightSource: 'levels', estimatedHeight: true }, 80)?.meters, 6);
});

test('camera fitting accounts for narrow screens and taller previews without distant fixed minimum', () => {
  assert.ok(buildingCameraRange(50, 12, .6) > buildingCameraRange(50, 12, 1));
  assert.ok(buildingCameraRange(50, 12, 1.8) > buildingCameraRange(50, 12, 1));
  assert.ok(buildingCameraRange(50, 80, 1.8) > buildingCameraRange(50, 12, 1.8));
  assert.ok(buildingCameraRange(20, 6, 1.8) < 240);
  assert.ok(Number.isFinite(buildingCameraRange(NaN, NaN, 0)));
});

test('button zoom derives from the live camera distance and respects near/far bounds', () => {
  assert.equal(zoomedDistance(500, 'in'), 380);
  assert.equal(zoomedDistance(200, 'in'), 152);
  assert.equal(zoomedDistance(35, 'in'), 35);
  assert.equal(zoomedDistance(24999, 'out'), 25000);
});
