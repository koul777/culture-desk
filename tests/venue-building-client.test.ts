import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startVenueBuildingRequest, type BuildingResult } from '../web/lib/venue-building-client.js';

const unavailable = (id: number): BuildingResult => ({ status: 'unavailable', performanceId: id, source: 'OpenStreetMap', attribution: 'Source attribution',
  building: null, reason: 'no_matching_building', message: 'No verified footprint', checkedAt: '2026-10-19T00:00:00Z' });

test('the selected OSM consumer starts immediately and preserves an unavailable response without manufacturing geometry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0, signal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', (url: string, options: RequestInit) => {
    calls++; signal = options.signal as AbortSignal;
    assert.equal(url, '/api/venues/building?performanceId=7');
    assert.equal(options.credentials, 'same-origin');
    return Promise.resolve(new Response(JSON.stringify(unavailable(7))));
  });
  const request = startVenueBuildingRequest(7);
  assert.equal(calls, 1, 'network starts before a renderer awaits the result');
  assert.deepEqual(await request.result, { kind: 'result', value: unavailable(7) });
  t.mock.timers.tick(25_001);
  assert.equal(signal?.aborted, false, 'completed request releases its deadline timer');
});

test('closing one opening aborts only its consumer and rapid reopening owns a fresh signal', async t => {
  const pending: { signal: AbortSignal; resolve: (response: Response) => void }[] = [];
  t.mock.method(globalThis, 'fetch', (_url: string, options: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = options.signal as AbortSignal;
    pending.push({ signal, resolve });
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const first = startVenueBuildingRequest(8);
  first.cancel(); first.cancel();
  const second = startVenueBuildingRequest(8);
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(pending[1].signal.aborted, false);
  assert.notEqual(pending[0].signal, pending[1].signal);
  assert.deepEqual(await first.result, { kind: 'cancelled' });
  pending[1].resolve(new Response(JSON.stringify(unavailable(8))));
  assert.deepEqual(await second.result, { kind: 'result', value: unavailable(8) });
});

test('late JSON after close cannot become visible success or timeout fallback', async t => {
  let finish!: (value: BuildingResult) => void;
  let reading!: () => void;
  const readingBody = new Promise<void>(resolve => { reading = resolve; });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: () => { reading(); return new Promise<BuildingResult>(resolve => { finish = resolve; }); } } as Response));
  const request = startVenueBuildingRequest(9);
  await readingBody;
  request.cancel();
  finish(unavailable(9));
  assert.deepEqual(await request.result, { kind: 'cancelled' });
});

test('the request deadline starts before renderer consumption and produces a distinct timeout outcome', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', (_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    signal = options.signal as AbortSignal;
    signal.addEventListener('abort', () => reject(signal!.reason), { once: true });
  }));
  const request = startVenueBuildingRequest(10);
  t.mock.timers.tick(24_999); assert.equal(signal?.aborted, false);
  t.mock.timers.tick(1); assert.equal(signal?.aborted, true);
  assert.deepEqual(await request.result, { kind: 'failed', reason: 'timeout' });
});

test('network, HTTP and JSON failures settle safely while the renderer is still loading', async t => {
  const responses: (() => Promise<Response>)[] = [
    () => Promise.reject(new Error('Network failed')),
    () => Promise.resolve(new Response('Unavailable', { status: 503 })),
    () => Promise.resolve(new Response('not json')),
  ];
  t.mock.method(globalThis, 'fetch', () => responses.shift()!());
  for (let id = 0; id < 3; id++) {
    const request = startVenueBuildingRequest(id);
    await new Promise(setImmediate);
    assert.deepEqual(await request.result, { kind: 'failed', reason: 'upstream_unavailable' });
  }
});
