import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, ApiError } from '../web/api.js';
import { snapshotAvailability } from '../web/lib/snapshot-availability.js';

test('search fallback blocks collection transport, and a healthy bootstrap restores it', async t => {
  const fallback = { mode: 'snapshot', snapshotAt: '2026-10-16T11:00:00.000Z', reason: 'database_unavailable' };
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (path: string) => {
    calls++;
    return new Response(JSON.stringify(path.startsWith('/api/performances?') ? { items: [], fallback } : {}));
  });
  await api.search({});
  assert.equal(snapshotAvailability.get()?.snapshotAt, fallback.snapshotAt);
  const before = calls;
  await assert.rejects(api.cloudTick(), error => error instanceof ApiError && error.status === 503);
  await assert.rejects(api.requestDetails({}), /일시 중단/);
  assert.equal(calls, before);
  await api.map({});
  assert.ok(snapshotAvailability.get());
  await api.bootstrap();
  assert.equal(snapshotAvailability.get(), null);
  await api.cloudTick();
  assert.equal(calls, before + 3);
});

test('an outage response on a write activates snapshot mode without exposing provider error data', async t => {
  t.mock.method(globalThis, 'fetch', async (path: string) => new Response(JSON.stringify(path === '/api/bootstrap' ? {} : {
    error: '저장소 연결 제한으로 변경 작업이 중단되었습니다.',
    fallback: { mode: 'snapshot', snapshotAt: '2026-10-16T11:00:00.000Z', reason: 'database_unavailable' },
  }), { status: path === '/api/bootstrap' ? 200 : 503 }));
  await api.bootstrap();
  await assert.rejects(api.cloudTick(), error => error instanceof ApiError && error.status === 503);
  assert.equal(snapshotAvailability.get()?.mode, 'snapshot');
  await api.bootstrap();
});
