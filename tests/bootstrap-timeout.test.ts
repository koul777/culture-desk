import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bootstrap } from '../shared/types';
import { api, ApiError } from '../web/api.js';
import { createBootstrapRefresh } from '../web/lib/bootstrap-refresh.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

const snapshot: Bootstrap = {
  cities: [], sources: [], bookmarkCount: 0, pendingDetails: 0,
  reviewCount: 0, excludedCount: 0, runs: [], today: '2026-10-16',
};
const isTimeout = (error: unknown) => error instanceof ApiError && error.status === 408 && /30초/.test(error.message);

test('bootstrap aborts its actual request at 30 seconds and reports a clear timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', (_path: string, options: RequestInit) => {
    signal = options.signal!;
    return new Promise<Response>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
  });
  const result = assert.rejects(api.bootstrap(), isTimeout);
  assert.ok(signal);
  t.mock.timers.tick(29_999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(signal.aborted, true);
  await result;
});

test('a successful JSON body finishing after abort is rejected rather than applied', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const body = deferred<Bootstrap>();
  const started = deferred<void>();
  let signal: AbortSignal | undefined;
  const response = new Response('{}');
  t.mock.method(response, 'json', () => { started.resolve(); return body.promise; });
  t.mock.method(globalThis, 'fetch', async (_path: string, options: RequestInit) => { signal = options.signal!; return response; });
  const applied: Bootstrap[] = [];
  const result = assert.rejects(api.bootstrap().then(value => { applied.push(value); }), isTimeout);
  await started.promise;
  t.mock.timers.tick(30_000);
  assert.equal(signal?.aborted, true);
  body.resolve(snapshot);
  await result;
  assert.deepEqual(applied, []);
});

test('a timed-out shared read releases a queued fresh read and later polls can continue', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  let active = 0;
  let peak = 0;
  t.mock.method(globalThis, 'fetch', async (_path: string, options: RequestInit) => {
    calls++; active++; peak = Math.max(peak, active);
    try {
      if (calls === 1) await new Promise<void>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true }));
      return new Response(JSON.stringify(snapshot));
    } finally { active--; }
  });
  const applied: Bootstrap[] = [];
  const refresh = createBootstrapRefresh(async () => { const value = await api.bootstrap(); applied.push(value); return value; });
  const first = refresh.shared();
  const failure = assert.rejects(first, isTimeout);
  await Promise.resolve();
  const afterWrite = refresh.fresh();
  assert.equal(calls, 1);
  t.mock.timers.tick(30_000);
  await failure;
  assert.deepEqual(await afterWrite, snapshot);
  assert.deepEqual(await refresh.shared(), snapshot);
  assert.equal(calls, 3);
  assert.equal(peak, 1);
  assert.equal(applied.length, 2);
});

test('successful reads clear their deadline and ordinary server failures remain retryable', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals: AbortSignal[] = [];
  let fail = true;
  t.mock.method(globalThis, 'fetch', async (_path: string, options: RequestInit) => {
    signals.push(options.signal!);
    return fail ? new Response(JSON.stringify({ error: '잠시 후 다시 시도하세요.' }), { status: 503 }) : new Response(JSON.stringify(snapshot));
  });
  await assert.rejects(api.bootstrap(), error => error instanceof ApiError && error.status === 503);
  fail = false;
  assert.deepEqual(await api.bootstrap(), snapshot);
  t.mock.timers.tick(60_000);
  assert.ok(signals.every(signal => !signal.aborted));
});

test('cloud tick and search requests do not inherit the bootstrap deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const release = deferred<void>();
  const signals: Array<AbortSignal | null | undefined> = [];
  t.mock.method(globalThis, 'fetch', async (_path: string, options: RequestInit) => {
    signals.push(options.signal);
    await release.promise;
    return new Response(JSON.stringify({ ok: true }));
  });
  const tick = api.cloudTick();
  const search = api.search({});
  t.mock.timers.tick(35_000);
  assert.deepEqual(signals, [undefined, undefined]);
  release.resolve();
  assert.deepEqual(await Promise.all([tick, search]), [{ ok: true }, { ok: true }]);
});
