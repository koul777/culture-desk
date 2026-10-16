import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { City } from '../shared/types';
import { createBootstrapRefresh, preserveCityReference } from '../web/lib/bootstrap-refresh.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('simultaneous polls share one read and a later poll can read again', async () => {
  const response = deferred<number>();
  let calls = 0;
  const refresh = createBootstrapRefresh(() => { calls++; return response.promise; });
  const reads = Array.from({ length: 10 }, () => refresh.shared());
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.ok(reads.every(read => read === reads[0]));
  response.resolve(1);
  assert.deepEqual(await Promise.all(reads), Array(10).fill(1));
  assert.equal(await refresh.shared(), 1);
  assert.equal(calls, 2);
});

test('a refresh after a write waits for an older poll then reads fresh without overlapping or stale overwrite', async () => {
  const response = deferred<number>();
  const commits: number[] = [];
  let database = 1;
  let calls = 0;
  let concurrent = 0;
  let peak = 0;
  const refresh = createBootstrapRefresh(async () => {
    calls++; concurrent++; peak = Math.max(peak, concurrent);
    const snapshot = database;
    if (calls === 1) await response.promise;
    commits.push(snapshot); concurrent--;
    return snapshot;
  });
  const poll = refresh.shared();
  await Promise.resolve();
  database = 2; // A completed mutation, while the old read is still on the wire.
  const afterWrite = refresh.fresh();
  const anotherAfterWrite = refresh.fresh();
  assert.equal(calls, 1);
  response.resolve(0);
  assert.equal(await poll, 1);
  assert.deepEqual(await Promise.all([afterWrite, anotherAfterWrite]), [2, 2]);
  assert.equal(calls, 2);
  assert.equal(peak, 1);
  assert.deepEqual(commits, [1, 2]);
});

test('another mutation during the fresh read requires a subsequent read, not that in-flight snapshot', async () => {
  const first = deferred<void>();
  const second = deferred<void>();
  const startedSecond = deferred<void>();
  let database = 1;
  let calls = 0;
  const refresh = createBootstrapRefresh(async () => {
    const snapshot = database;
    calls++;
    if (calls === 1) await first.promise;
    if (calls === 2) { startedSecond.resolve(); await second.promise; }
    return snapshot;
  });
  const poll = refresh.shared();
  await Promise.resolve();
  database = 2;
  const afterFirstWrite = refresh.fresh();
  first.resolve();
  await startedSecond.promise;
  database = 3;
  const afterSecondWrite = refresh.fresh();
  second.resolve();
  assert.equal(await poll, 1);
  assert.equal(await afterFirstWrite, 2);
  assert.equal(await afterSecondWrite, 3);
  assert.equal(calls, 3);
});

test('an unsuccessful pending poll cannot block a fresh refresh or mark a poll as recently successful', async () => {
  const response = deferred<number>();
  let calls = 0;
  const refresh = createBootstrapRefresh(() => ++calls === 1 ? response.promise : Promise.resolve(2));
  const failedPoll = refresh.shared();
  const observedFailure = assert.rejects(failedPoll, /offline/);
  const fresh = refresh.fresh();
  assert.equal(refresh.isDue(3000), true);
  response.reject(new Error('offline'));
  await observedFailure;
  assert.equal(await fresh, 2);
  assert.equal(refresh.isDue(3000), false);
  assert.equal(calls, 2);
});

test('poll freshness follows successful completion but never skips an explicit refresh', async () => {
  let clock = 0;
  let calls = 0;
  let fail = false;
  const refresh = createBootstrapRefresh(async () => {
    calls++;
    if (fail) throw new Error('offline');
    return calls;
  }, () => clock);
  assert.equal(refresh.isDue(3000), true);
  await refresh.shared();
  clock = 2999;
  assert.equal(refresh.isDue(3000), false);
  clock = 3000;
  assert.equal(refresh.isDue(3000), true);
  await refresh.fresh();
  assert.equal(refresh.isDue(3000), false);
  await refresh.fresh();
  assert.equal(calls, 3);
  clock = 6000; fail = true;
  await assert.rejects(refresh.shared(), /offline/);
  assert.equal(refresh.isDue(3000), true);
  fail = false;
  assert.equal(await refresh.shared(), 5);
});

test('the short coalescing window preserves a normal three-second poll after a delayed response', async () => {
  let clock = 0;
  const response = deferred<number>();
  const refresh = createBootstrapRefresh(() => response.promise, () => clock);
  const first = refresh.shared();
  clock = 400;
  response.resolve(1);
  await first;
  clock = 900;
  assert.equal(refresh.isDue(1000), false);
  clock = 3000;
  assert.equal(refresh.isDue(1000), true);
});

test('unchanged city data retains marker identity while progress and actual catalogue changes are delivered', () => {
  const city: City = { id: 'wonju', name: '원주시', sido: '강원특별자치도', sigungu: '원주시', kopisSido: '51', kopisSigungu: '130', aliases: ['원주'], latitude: 37.342, longitude: 127.92 };
  const previous = { cities: [city], doneTasks: 10 };
  const next = { cities: [{ ...city, aliases: [...city.aliases] }], doneTasks: 20 };
  const shared = preserveCityReference(previous, next);
  assert.equal(shared.cities, previous.cities);
  assert.equal(shared.doneTasks, 20);
  assert.notEqual(next.cities, previous.cities); // The response itself is not mutated.
  for (const change of [{ latitude: 37.35 }, { name: '원주' }, { aliases: ['원주', '문막'] }]) {
    const changed = { ...next, cities: [{ ...city, ...change }] };
    assert.equal(preserveCityReference(previous, changed), changed);
  }
  assert.equal(preserveCityReference(null, next), next);
});
