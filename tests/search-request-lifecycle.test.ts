import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { api, ApiError } from '../web/api.js';
import { snapshotAvailability } from '../web/lib/snapshot-availability.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

const fallback = {
  mode: 'snapshot', snapshotAt: '2026-10-18T01:00:00.000Z', reason: 'database_unavailable',
} as const;
const resetAvailability = () => snapshotAvailability.observe(snapshotAvailability.begin(), {}, true);
beforeEach(resetAvailability);
afterEach(resetAvailability);

for (const endpoint of ['search', 'map'] as const) {
  test(`${endpoint} passes cancellation to fetch without turning it into an offline error`, async t => {
    const controller = new AbortController();
    let received: AbortSignal | null | undefined;
    t.mock.method(globalThis, 'fetch', (_path: string, options: RequestInit) => {
      received = options.signal;
      return new Promise<Response>((_resolve, reject) => {
        received!.addEventListener('abort', () => reject(received!.reason), { once: true });
      });
    });
    const reason = new DOMException('Superseded search', 'AbortError');
    const rejected = assert.rejects(api[endpoint]({ q: 'old' }, controller.signal), error => error === reason);
    assert.equal(received, controller.signal);
    controller.abort(reason);
    await rejected;
    assert.equal(snapshotAvailability.get(), null);
  });

  test(`${endpoint} skips transport when the caller already cancelled`, async t => {
    const controller = new AbortController();
    controller.abort();
    const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
    await assert.rejects(api[endpoint]({}, controller.signal), error => error === controller.signal.reason);
    assert.equal(fetch.mock.callCount(), 0);
  });

  test(`${endpoint} rejects a late transport response after cancellation`, async t => {
    const controller = new AbortController();
    const transport = deferred<Response>();
    t.mock.method(globalThis, 'fetch', () => transport.promise);
    const rejected = assert.rejects(api[endpoint]({}, controller.signal), error => error === controller.signal.reason);
    controller.abort();
    transport.resolve(new Response(JSON.stringify({ items: [], fallback })));
    await rejected;
    assert.equal(snapshotAvailability.get(), null);
  });

  for (const status of [200, 503]) {
    test(`${endpoint} ignores a ${status} body decoded after cancellation, including snapshot state`, async t => {
      const controller = new AbortController();
      const body = deferred<unknown>();
      const reading = deferred<void>();
      const response = new Response('{}', { status });
      t.mock.method(response, 'json', () => { reading.resolve(); return body.promise; });
      t.mock.method(globalThis, 'fetch', async () => response);
      const rejected = assert.rejects(api[endpoint]({}, controller.signal), error => error === controller.signal.reason);
      await reading.promise;
      controller.abort();
      body.resolve({ items: [], error: 'Storage unavailable', fallback });
      await rejected;
      assert.equal(snapshotAvailability.get(), null);
    });
  }

  test(`${endpoint} still observes snapshot availability for an active request`, async t => {
    const controller = new AbortController();
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ items: [], fallback })));
    const result = await api[endpoint]({}, controller.signal);
    assert.deepEqual(result.items, []);
    assert.deepEqual(snapshotAvailability.get(), fallback);
    assert.equal(controller.signal.aborted, false);
  });
}

test('active search network, HTTP, and unreadable-response failures keep their useful errors', async t => {
  const controller = new AbortController();
  let mode: 'network' | 'http' | 'body' = 'network';
  t.mock.method(globalThis, 'fetch', async () => {
    if (mode === 'network') throw new TypeError('Failed to fetch');
    if (mode === 'http') return new Response(JSON.stringify({ error: '잠시 후 다시 시도하세요.', fallback }), { status: 503 });
    return new Response('invalid JSON');
  });
  await assert.rejects(api.search({}, controller.signal), error => error instanceof ApiError && error.status === 0 && /서버에 연결/.test(error.message));
  mode = 'http';
  await assert.rejects(api.search({}, controller.signal), error => error instanceof ApiError && error.status === 503 && error.message === '잠시 후 다시 시도하세요.');
  assert.deepEqual(snapshotAvailability.get(), fallback);
  mode = 'body';
  await assert.rejects(api.search({}, controller.signal), error => error instanceof ApiError && error.status === 200 && /응답을 읽을 수/.test(error.message));
});
