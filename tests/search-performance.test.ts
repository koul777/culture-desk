import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { NATIONAL_CITIES } from '../server/providers/cities.js';
import type { SearchPerformanceEvent, SearchPerformanceTrace } from '../server/search-performance.js';
import type { PerformanceInput } from '../shared/types.js';

const record: PerformanceInput = {
  source: 'kopis', sourceId: 'TEST_PROFILE', title: 'TEST 공연', cityId: 'andong',
  startDate: '2026-10-01', endDate: '2026-10-31', genre: '연극', sourceGenre: '', venue: 'TEST 극장',
  address: '', poster: '', sourceUrl: '', price: '', priceType: 'unknown', age: '', runtime: '', cast: '',
  producer: '', organizer: '', contact: '', schedule: '', description: '', status: '', detailState: 'complete',
  classification: 'performance', reviewReason: '', raw: null,
};
const config = { port: 4317, databasePath: ':memory:', keys: { kopis: '', culture: '' }, requestIntervalMs: 350, syncIntervalHours: 24 };
const publishedAt = '2026-10-01T00:00:00.000Z';

async function fixture(t: TestContext, options: { readonlySnapshotAt?: string; performanceTrace?: SearchPerformanceTrace } = {}) {
  const store = new Store(':memory:', NATIONAL_CITIES, { performanceTrace: options.performanceTrace });
  store.upsert(record);
  store.db.prepare('UPDATE performances SET updated_at=?').run(publishedAt);
  store.db.exec('PRAGMA query_only=ON');
  const { app } = await createApp(config, { store, providers: {}, startWorker: false, serveStatic: false, searchOnly: true, ...options });
  t.after(async () => { await app.close(); store.close(); });
  return app;
}

test('read-only snapshot time is applied consistently to search and map envelopes', async t => {
  const app = await fixture(t, { readonlySnapshotAt: publishedAt });
  for (const route of ['/api/performances', '/api/map']) {
    const response = await app.inject(route);
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().snapshotAt, publishedAt);
    assert.equal(response.json().total, 1);
    assert.equal(response.json().items[0].title, record.title);
  }
});

test('ordinary search and map keep per-read timestamps when no snapshot time is provided', async t => {
  const app = await fixture(t);
  for (const route of ['/api/performances', '/api/map']) {
    const started = Date.now();
    const response = await app.inject(route);
    const at = Date.parse(response.json().snapshotAt);
    assert.ok(at >= started && at <= Date.now());
  }
});

test('opt-in phase diagnostics report timings without altering read-only API output', async t => {
  const events: SearchPerformanceEvent[] = [];
  const profiled = await fixture(t, { readonlySnapshotAt: publishedAt, performanceTrace: event => events.push(event) });
  const ordinary = await fixture(t, { readonlySnapshotAt: publishedAt });
  for (const route of ['/api/performances', '/api/map', '/api/performances?price=unknown']) {
    const expected = await ordinary.inject(route);
    const actual = await profiled.inject(route);
    assert.equal(actual.payload, expected.payload);
  }
  const phases = new Set(events.map(event => event.phase));
  for (const phase of ['search.counts', 'search.pending', 'search.sourceCounts', 'search.rows', 'search.coverage', 'search.decode', 'map.project', 'map.budget', 'fastify.serialize']) {
    assert.ok(phases.has(phase), `missing phase ${phase}`);
  }
  assert.ok(events.every(event => Number.isFinite(event.durationMs) && event.durationMs >= 0));
  assert.ok(events.every(event => Object.keys(event).every(key => ['phase', 'durationMs', 'rows', 'bytes'].includes(key))));
});
