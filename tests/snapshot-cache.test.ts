import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotRepository, type SnapshotClient, type SnapshotPool } from '../server/cloud/snapshot.js';
import { DEFAULT_CITIES } from '../server/providers/cities.js';

/** A revision-aware transport: records the bytes crossing the database boundary. */
class VersionedPool implements SnapshotPool {
  data: Buffer | null = null;
  revision = 0;
  payloadReads: number[] = [];
  failWrite = false;
  async connect(): Promise<SnapshotClient> {
    let pending: Buffer | undefined;
    return {
      query: async (sql, values = []) => {
        if (sql.startsWith('SELECT ')) {
          const unchanged = sql.includes('CASE WHEN revision=') && String(values[0]) === String(this.revision);
          const data = unchanged ? null : this.data;
          this.payloadReads.push(data?.byteLength ?? 0);
          return { rows: [{ data, revision: String(this.revision) }] };
        }
        if (sql.startsWith('UPDATE culture_desk_snapshot')) {
          if (this.failWrite) throw new Error('simulated commit failure');
          pending = Buffer.from(values[0]);
          return { rows: [], rowCount: 1 };
        }
        if (sql === 'COMMIT' && pending) { this.data = pending; this.revision++; pending = undefined; }
        if (sql === 'ROLLBACK') pending = undefined;
        return { rows: [] };
      },
      release() {},
    };
  }
}
const city = (id: string) => ({ ...DEFAULT_CITIES[0], id });
const ids = (repo: SnapshotRepository) => repo.withStore(false, async store => store.cities().map(value => value.id));

test('unchanged reads check the current revision without downloading the snapshot again', async () => {
  const pool = new VersionedPool(); const repo = new SnapshotRepository(pool);
  await repo.withStore(true, async store => { store.addCity(city('saved-city')); });
  pool.payloadReads = [];
  const first = await ids(repo);
  const second = await ids(repo);
  assert.deepEqual(second, first);
  assert.ok(first.includes('saved-city'));
  assert.equal(pool.payloadReads.length, 2, 'exactly one version-and-payload query per read');
  assert.ok(pool.payloadReads[0] > 0);
  assert.equal(pool.payloadReads[1], 0);
});

test('a write from another instance is visible on the very next cached read', async () => {
  const pool = new VersionedPool(); const reader = new SnapshotRepository(pool); const writer = new SnapshotRepository(pool);
  await writer.withStore(true, async store => { store.addCity(city('before-refresh')); });
  await ids(reader); await ids(reader);
  await writer.withStore(true, async store => { store.addCity(city('after-refresh')); });
  pool.payloadReads = [];
  assert.ok((await ids(reader)).includes('after-refresh'));
  assert.ok(pool.payloadReads[0] > 0, 'new revision must return its payload atomically');
  assert.ok((await ids(reader)).includes('after-refresh'));
  assert.equal(pool.payloadReads[1], 0);
});

test('cached empty databases observe seeding and read-only temporary changes never enter the cache', async () => {
  const pool = new VersionedPool(); const repo = new SnapshotRepository(pool);
  await ids(repo);
  await repo.withStore(true, async store => { store.addCity(city('newly-seeded')); });
  assert.ok((await ids(repo)).includes('newly-seeded'));
  await repo.withStore(false, async store => { store.addCity(city('temporary-read-mutation')); });
  assert.equal((await ids(repo)).includes('temporary-read-mutation'), false);
});

test('failed persistence cannot make uncommitted records visible through the read cache', async () => {
  const pool = new VersionedPool(); const repo = new SnapshotRepository(pool);
  await repo.withStore(true, async store => { store.addCity(city('durable')); });
  await ids(repo);
  pool.failWrite = true;
  await assert.rejects(repo.withStore(true, async store => { store.addCity(city('failed')); }));
  const visible = await ids(repo);
  assert.ok(visible.includes('durable'));
  assert.equal(visible.includes('failed'), false);
  assert.equal(pool.payloadReads.at(-1), 0);
});

test('empty queue probes skip snapshot persistence but real mutations still commit', async () => {
  const pool = new VersionedPool(); const repo = new SnapshotRepository(pool);
  await repo.withStore(true, async store => { store.addCity(city('initial')); });
  const revision = pool.revision; const original = pool.data;
  const found = await repo.withStore(true, async store => store.db.prepare("SELECT id FROM sync_tasks WHERE state='queued' LIMIT 1").get(), { skipUnchanged: true });
  assert.equal(found, undefined);
  assert.equal(pool.revision, revision);
  assert.equal(pool.data, original);
  await repo.withStore(true, async store => { store.addCity(city('committed')); }, { skipUnchanged: true });
  assert.equal(pool.revision, revision + 1);
  assert.ok((await ids(repo)).includes('committed'));
});
