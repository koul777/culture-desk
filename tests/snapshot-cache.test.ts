import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotRepository } from '../server/cloud/snapshot.js';
import { DEFAULT_CITIES } from '../server/providers/cities.js';
import { PglitePool } from './helpers/pglite-pool.js';
import { committedRevision, durableState, plainSqliteBytes } from './helpers/cloud-storage.js';

// Real PostgreSQL semantics (PGlite): transfer counters record what crosses the database boundary.
const city = (id: string) => ({ ...DEFAULT_CITIES[0], id });
const ids = (repo: SnapshotRepository) => repo.withStore(false, async store => store.cities().map(value => value.id));
const FAIL_PERSISTENCE = /INSERT INTO culture_desk_delta|UPDATE culture_desk_base/;

test('unchanged reads check the current revision without downloading the snapshot again', async () => {
  const pool = new PglitePool();
  try {
    const writer = new SnapshotRepository(pool), reader = new SnapshotRepository(pool);
    await writer.withStore(true, async store => { store.addCity(city('saved-city')); });

    const first = await ids(reader);
    assert.ok(first.includes('saved-city'));
    assert.equal(reader.transfer.baseReads, 1, 'a cold reader downloads the base once');
    assert.ok(reader.transfer.baseBytesRead > 0);

    const warm = { ...reader.transfer }, mark = pool.statements.length;
    const second = await ids(reader);
    assert.deepEqual(second, first);
    assert.deepEqual(reader.transfer, warm, 'neither the base nor journal rows are read again');
    const probes = pool.statements.slice(mark);
    assert.equal(probes.length, 1, 'exactly one revision probe per unchanged read');
    assert.match(probes[0], /FROM culture_desk_state/);
    assert.equal(probes.some(statement => /culture_desk_(base|delta)\b/.test(statement)), false);

    // The instance that committed a revision already holds it.
    const own = { ...writer.transfer };
    assert.deepEqual(await ids(writer), first);
    assert.deepEqual(writer.transfer, own, 'a writer reads back its own commit without downloading it');
  } finally { await pool.close(); }
});

test('a write from another instance is visible on the very next cached read', async () => {
  const pool = new PglitePool();
  try {
    const reader = new SnapshotRepository(pool), writer = new SnapshotRepository(pool);
    await writer.withStore(true, async store => { store.addCity(city('before-refresh')); });
    await ids(reader); await ids(reader);
    await writer.withStore(true, async store => { store.addCity(city('after-refresh')); });

    const before = { ...reader.transfer };
    assert.ok((await ids(reader)).includes('after-refresh'));
    assert.equal(reader.transfer.baseReads, before.baseReads, 'a warm reader catches up with journal rows, not a new base download');
    const rows = reader.transfer.journalRowsRead - before.journalRowsRead;
    assert.ok(rows >= 1 && rows <= 2, `the new revision arrived with the very next read (${rows} journal rows)`);

    const after = { ...reader.transfer };
    assert.ok((await ids(reader)).includes('after-refresh'));
    assert.deepEqual(reader.transfer, after, 'once caught up, the next read transfers nothing');
  } finally { await pool.close(); }
});

test('cached empty databases observe seeding and read-only temporary changes never enter the cache', async () => {
  const pool = new PglitePool();
  try {
    const repo = new SnapshotRepository(pool), seeder = new SnapshotRepository(pool);
    assert.equal((await ids(repo)).includes('newly-seeded'), false);
    const empty = await committedRevision(pool);

    assert.equal(await seeder.seedIfEmpty(plainSqliteBytes(store => store.addCity(city('newly-seeded')))), true);
    assert.ok(await committedRevision(pool) > empty, 'seeding commits a revision');
    assert.ok((await ids(repo)).includes('newly-seeded'), 'the instance that cached the empty database sees the seed');

    // Seeding never replaces an existing cloud database.
    const seeded = await durableState(pool);
    assert.equal(await seeder.seedIfEmpty(plainSqliteBytes(store => store.addCity(city('must-not-replace')))), false);
    assert.deepEqual(await durableState(pool), seeded);
    assert.equal((await ids(repo)).includes('must-not-replace'), false);

    await repo.withStore(true, async store => { store.addCity(city('newly-written')); });
    assert.ok((await ids(repo)).includes('newly-written'));
    assert.ok((await ids(seeder)).includes('newly-written'));

    const durable = await durableState(pool), writes = pool.writes;
    await repo.withStore(false, async store => { store.addCity(city('temporary-read-mutation')); });
    assert.equal((await ids(repo)).includes('temporary-read-mutation'), false);
    assert.equal((await ids(new SnapshotRepository(pool))).includes('temporary-read-mutation'), false);
    assert.equal(pool.writes, writes);
    assert.deepEqual(await durableState(pool), durable, 'a read-only request persists nothing');
  } finally { await pool.close(); }
});

test('failed persistence cannot make uncommitted records visible through the read cache', async () => {
  const pool = new PglitePool();
  try {
    const repo = new SnapshotRepository(pool), other = new SnapshotRepository(pool);
    await repo.withStore(true, async store => { store.addCity(city('durable')); });
    await ids(repo); await ids(other);
    const durable = await durableState(pool), writes = pool.writes;

    pool.failOn = FAIL_PERSISTENCE;
    await assert.rejects(repo.withStore(true, async store => { store.addCity(city('failed')); }), /simulated persistence failure/);
    assert.equal(pool.failOn, null, 'the injected persistence failure was reached');
    assert.equal(pool.writes, writes);
    assert.deepEqual(await durableState(pool), durable, 'nothing of the failed write was committed');

    const before = { ...repo.transfer };
    const visible = await ids(repo);
    assert.ok(visible.includes('durable'));
    assert.equal(visible.includes('failed'), false);
    assert.deepEqual(repo.transfer, before, 'the cached committed revision is still current, so nothing is downloaded');
    assert.equal((await ids(other)).includes('failed'), false);
    assert.equal((await ids(new SnapshotRepository(pool))).includes('failed'), false);

    // A COMMIT that fails must not leave its working copy in the cache either: the next successful
    // commit (by another instance) takes the very revision number the failed one would have had.
    pool.failOn = /^COMMIT/;
    await assert.rejects(repo.withStore(true, async store => { store.addCity(city('failed-commit')); }), /simulated persistence failure/);
    assert.equal(pool.failOn, null, 'the injected commit failure was reached');
    assert.equal(pool.writes, writes);
    assert.deepEqual(await durableState(pool), durable);
    await other.withStore(true, async store => { store.addCity(city('after-failed-commit')); });
    const later = await ids(repo);
    assert.ok(later.includes('after-failed-commit'), 'the reader sees the revision that was actually committed');
    assert.equal(later.includes('failed-commit'), false, 'and never the working copy of the failed commit');
    assert.equal((await ids(new SnapshotRepository(pool))).includes('failed-commit'), false);
  } finally { await pool.close(); }
});

test('empty queue probes skip snapshot persistence but real mutations still commit', async () => {
  const pool = new PglitePool();
  try {
    const repo = new SnapshotRepository(pool);
    await repo.withStore(true, async store => { store.addCity(city('initial')); });
    const revision = await committedRevision(pool), durable = await durableState(pool), writes = pool.writes;

    // Callers pass skipUnchanged; an unchanged request commits nothing with or without it.
    for (const options of [{ skipUnchanged: true }, {}]) {
      const found = await repo.withStore(true, async store => store.db.prepare("SELECT id FROM sync_tasks WHERE state='queued' LIMIT 1").get(), options);
      assert.equal(found, undefined);
      assert.equal(await committedRevision(pool), revision);
      assert.equal(pool.writes, writes);
      assert.deepEqual(await durableState(pool), durable);
    }

    await repo.withStore(true, async store => { store.addCity(city('committed')); }, { skipUnchanged: true });
    assert.equal(await committedRevision(pool), revision + 1);
    assert.equal(pool.writes, writes + 1);
    assert.ok((await ids(repo)).includes('committed'));
    assert.ok((await ids(new SnapshotRepository(pool))).includes('committed'), 'the mutation is durable, not only cached');
  } finally { await pool.close(); }
});
