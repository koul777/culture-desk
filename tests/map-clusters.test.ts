import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clusterProjectedPoints } from '../web/lib/map-clusters.js';

test('projected clustering retains every venue and performance count exactly once', () => {
  const points = Array.from({ length: 969 }, (_, id) => ({ id, x: (id % 30) * 8, y: Math.floor(id / 30) * 8, count: id % 8 + 1 }));
  const groups = clusterProjectedPoints(points, 6);
  assert.ok(groups.length < 25);
  assert.deepEqual(new Set(groups.flat().map(point => point.id)), new Set(points.map(point => point.id)));
  assert.equal(groups.flat().length, points.length);
  assert.equal(groups.reduce((sum, group) => sum + group.reduce((n, point) => n + point.count, 0), 0), points.reduce((sum, point) => sum + point.count, 0));
});

test('zooming separates projected neighbours and releases all individual venues at street zoom', () => {
  const points = [{ id: 'a', x: 10, y: 10 }, { id: 'b', x: 25, y: 25 }, { id: 'c', x: 100, y: 100 }];
  assert.equal(clusterProjectedPoints(points, 6).length, 2);
  assert.equal(clusterProjectedPoints(points.map(point => ({ ...point, x: point.x * 8, y: point.y * 8 })), 9).length, 3);
  assert.equal(clusterProjectedPoints(points, 14).length, 3);
  assert.equal(clusterProjectedPoints([{ x: 0, y: 0 }, { x: 0, y: 0 }], 14).length, 2);
});

test('empty data stays empty and separated coordinates never merge across distant cells', () => {
  assert.deepEqual(clusterProjectedPoints([], 5), []);
  assert.equal(clusterProjectedPoints([{ x: -10000, y: 0 }, { x: 10000, y: 0 }], 5).length, 2);
});

test('neighbours across a grid boundary do not leave overlapping cluster circles', () => {
  const points = [{ id: 1, x: 74, y: 20 }, { id: 2, x: 77, y: 21 }, { id: 3, x: 150, y: 100 }];
  const groups = clusterProjectedPoints(points, 7);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].map(point => point.id), [1, 2]);
});
