import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PublishedResponseCache } from '../server/cloud/published-response-cache.js';
import { handleCloudRequest, type CloudOptions } from '../server/cloud/handler.js';
import { loadReadonlyFallback, type PublicReadonlySnapshot } from '../server/cloud/readonly-fallback.js';

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'x-test': 'preserved', 'cache-control': 'private, no-store' } });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

test('simultaneous identical published reads share work and each reader owns its response body', async () => {
  const cache = new PublishedResponseCache(); const gate = deferred<Response>(); let calls = 0;
  const produce = () => { calls++; return gate.promise; };
  const first = cache.read('/map', '2026-10-18', produce);
  const second = cache.read('/map', '2026-10-18', produce);
  gate.resolve(json({ total: 5600 }));
  const responses = await Promise.all([first, second, cache.read('/map', '2026-10-18', produce)]);
  assert.equal(calls, 1);
  for (const response of responses) {
    assert.deepEqual(await response.json(), { total: 5600 });
    assert.equal(response.headers.get('x-test'), 'preserved');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
});

test('query keys remain distinct and least recently used results obey entry and byte budgets', async () => {
  for (const cache of [new PublishedResponseCache(1000, 2), new PublishedResponseCache(14, 10)]) {
    const calls: string[] = [];
    const read = (key: string) => cache.read(key, 'day', async () => { calls.push(key); return json({ n: 1 }); }); // 7 bytes
    await read('a'); await read('b'); await read('a'); await read('c'); await read('a'); await read('b');
    assert.deepEqual(calls, ['a', 'b', 'c', 'b']);
  }
});

test('oversize and non-JSON responses are returned intact but never retained', async () => {
  for (const produceValue of [() => json({ data: 'x'.repeat(100) }), () => new Response('binary', { headers: { 'content-type': 'application/octet-stream' } })]) {
    const cache = new PublishedResponseCache(32); let calls = 0;
    const produce = async () => { calls++; return produceValue(); };
    const one = await (await cache.read('key', 'day', produce)).text();
    const two = await (await cache.read('key', 'day', produce)).text();
    assert.equal(one, two); assert.equal(calls, 2);
  }
});

test('failed reads are not cached and thrown producers release their pending slot for retry', async () => {
  const cache = new PublishedResponseCache(); let calls = 0;
  const produce = async () => { calls++; return json({ error: 'retry' }, 503); };
  const [one, two] = await Promise.all([cache.read('key', 'day', produce), cache.read('key', 'day', produce)]);
  assert.equal(calls, 1); assert.equal(one.status, 503); assert.equal(two.status, 503);
  assert.deepEqual(await one.json(), await two.json());
  await assert.rejects(cache.read('key', 'day', async () => { throw new Error('retry'); }), /retry/);
  assert.deepEqual(await (await cache.read('key', 'day', async () => json({ ok: true }))).json(), { ok: true });
});

test('a day change invalidates date-dependent data and an older in-flight request cannot overwrite it', async () => {
  const cache = new PublishedResponseCache(); const old = deferred<Response>();
  const earlier = cache.read('status=upcoming', '2026-10-18', () => old.promise);
  const fresh = await cache.read('status=upcoming', '2026-10-19', async () => json({ day: 19 }));
  old.resolve(json({ day: 18 }));
  assert.deepEqual(await (await earlier).json(), { day: 18 });
  assert.deepEqual(await fresh.json(), { day: 19 });
  const cached = await cache.read('status=upcoming', '2026-10-19', async () => { throw new Error('must not produce'); });
  assert.deepEqual(await cached.json(), { day: 19 });
});

const snapshot = (title: string): PublicReadonlySnapshot => ({
  version: 1, snapshotAt: '2026-10-18T00:00:00.000Z', performances: [{
    id: 1, source: 'kopis', sourceId: 'TEST_CACHE', title, cityId: 'andong', startDate: '2026-10-01', endDate: '2026-12-31',
    genre: '음악', sourceGenre: '', venue: 'TEST', address: '', poster: '', sourceUrl: '', price: '', priceType: 'unknown', age: '',
    runtime: '', cast: '', producer: '', organizer: '', contact: '', schedule: '', description: '', status: '', detailState: 'complete',
    classification: 'performance', reviewReason: '', updatedAt: '2026-10-18T00:00:00.000Z',
  }],
});
const request = (path: string, method = 'GET') => new Request(`https://published.test${path}`, { method });

test('published caches are isolated by snapshot and preserve filters, errors, HEAD and read-only routes', async () => {
  const first: CloudOptions = { env: {}, readonlyFallback: { load: async () => snapshot('TEST FIRST') } };
  const second: CloudOptions = { env: {}, readonlyFallback: { load: async () => snapshot('TEST SECOND') } };
  const paths = ['/api/performances', '/api/map', '/api/performances/1', '/api/bootstrap'];
  await Promise.all(paths.flatMap(path => [first, second].map(options => handleCloudRequest(request(path), options))));
  const detail = async (options: CloudOptions) => (await (await handleCloudRequest(request('/api/performances/1'), options)).json()).title;
  assert.equal(await detail(first), 'TEST FIRST'); assert.equal(await detail(second), 'TEST SECOND');
  for (const options of [first, second]) {
    const empty = await handleCloudRequest(request('/api/performances?q=NO_MATCH'), options);
    assert.equal((await empty.json()).total, 0);
    assert.equal((await handleCloudRequest(request('/api/performances?from=invalid'), options)).status, 400);
    for (const path of paths) {
      const head = await handleCloudRequest(request(path, 'HEAD'), options);
      assert.equal(head.status, 200); assert.equal(await head.text(), '');
      assert.equal(head.headers.get('x-culture-data-mode'), 'published');
    }
    assert.equal((await handleCloudRequest(request('/api/sync', 'POST'), options)).status, 404);
    assert.equal((await loadReadonlyFallback(options.readonlyFallback))!.store.db.prepare('PRAGMA query_only').get()!.query_only, 1);
  }
});
