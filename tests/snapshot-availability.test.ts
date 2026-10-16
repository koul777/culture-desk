import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSnapshotAvailability, readSnapshotFallback } from '../web/lib/snapshot-availability.js';

const payload = { fallback: { mode: 'snapshot', snapshotAt: '2026-10-16T11:00:00.000Z', reason: 'database_unavailable' } };

test('snapshot mode validates metadata and reports its timestamp without accepting unrelated response shapes', () => {
  assert.equal(readSnapshotFallback(payload)?.snapshotAt, payload.fallback.snapshotAt);
  for (const value of [null, {}, { fallback: 'snapshot' }, { fallback: { ...payload.fallback, snapshotAt: 'unknown' } }, { fallback: { ...payload.fallback, mode: 'live' } }]) assert.equal(readSnapshotFallback(value), null);
});

test('a search can enter snapshot mode; only a fresh healthy bootstrap restores writes', () => {
  const state = createSnapshotAvailability();
  const updates: unknown[] = [];
  state.subscribe(value => updates.push(value));
  state.observe(state.begin(), payload);
  assert.equal(state.get()?.mode, 'snapshot');
  state.observe(state.begin(), { items: [] });
  assert.equal(state.get()?.mode, 'snapshot');
  state.observe(state.begin(), payload);
  assert.equal(updates.length, 1);
  state.observe(state.begin(), { cities: [] }, true);
  assert.equal(state.get(), null);
  assert.equal(updates.length, 2);
});

test('late responses cannot erase a newer outage or reintroduce an older snapshot after recovery', () => {
  const state = createSnapshotAvailability();
  const oldBootstrap = state.begin();
  const newSearch = state.begin();
  state.observe(newSearch, payload);
  state.observe(oldBootstrap, {}, true);
  assert.ok(state.get());
  const oldFallback = state.begin();
  const recovery = state.begin();
  state.observe(recovery, {}, true);
  state.observe(oldFallback, payload);
  assert.equal(state.get(), null);
});
