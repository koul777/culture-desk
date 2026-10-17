import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChangeTracker, applyJournal } from '../server/cloud/row-journal.js';
import { SnapshotRepository, MIN_COMPACTION_BYTES } from '../server/cloud/snapshot.js';
import { Store } from '../server/store.js';
import { NATIONAL_CITIES } from '../server/providers/cities.js';
import { importCollection } from '../server/import-collection.js';
import type { PerformanceInput } from '../shared/types.js';
import { PglitePool } from './helpers/pglite-pool.js';

const performance = (n: number, title = `TEST performance ${n}`): PerformanceInput => ({
  source: 'kopis', sourceId: `TEST_${n}`, cityId: 'andong', title, startDate: '2026-10-01', endDate: '2026-10-31',
  venue: 'TEST venue', genre: '연극', classification: 'performance', detailState: 'complete', raw: { id: n, title },
} as PerformanceInput);
const seed = (store: Store, count = 50) => store.transaction(() => { for (let n = 0; n < count; n++) store.upsert(performance(n)); });
const titles = (store: Store) => store.db.prepare("SELECT json_extract(data,'$.title') AS title FROM performances ORDER BY title").all().map(row => String(row.title));

test('the tracker records each changed row once, skips no-op updates and transient rows, and follows cascades', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE parent(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE child(parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE,tag TEXT NOT NULL,PRIMARY KEY(parent_id,tag));
    CREATE TABLE keyed(code TEXT PRIMARY KEY,value TEXT,UNIQUE(value));
    INSERT INTO parent VALUES(1,'one'),(2,'two'),(3,'three'); INSERT INTO child VALUES(1,'a'),(1,'b'),(3,'c'); INSERT INTO keyed VALUES('x','unique');`);
  const tracker = new ChangeTracker(db);
  db.exec(`UPDATE parent SET name='one' WHERE id=1; UPDATE parent SET name='TWO' WHERE id=2;
    INSERT INTO parent VALUES(4,'temporary'); DELETE FROM parent WHERE id=4;
    DELETE FROM parent WHERE id=1; INSERT INTO parent VALUES(5,'five');
    INSERT OR REPLACE INTO keyed VALUES('y','unique');`);
  const changes = tracker.collect(db);
  assert.equal(changes.fullRewrite, false);
  assert.deepEqual(changes.rows.map(row => [row.tbl, row.pk, row.data === null ? 'deleted' : 'upsert']), [
    ['child', '[1,"a"]', 'deleted'], ['child', '[1,"b"]', 'deleted'],
    ['keyed', '["x"]', 'deleted'], ['keyed', '["y"]', 'upsert'],
    ['parent', '[1]', 'deleted'], ['parent', '[2]', 'upsert'], ['parent', '[5]', 'upsert'],
  ]);
  const copy = new DatabaseSync(':memory:');
  copy.exec(`CREATE TABLE parent(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE child(parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE,tag TEXT NOT NULL,PRIMARY KEY(parent_id,tag));
    CREATE TABLE keyed(code TEXT PRIMARY KEY,value TEXT,UNIQUE(value));
    INSERT INTO parent VALUES(1,'one'),(2,'two'),(3,'three'); INSERT INTO child VALUES(1,'a'),(1,'b'),(3,'c'); INSERT INTO keyed VALUES('x','unique');`);
  applyJournal(copy, changes.rows);
  for (const table of ['parent', 'child', 'keyed']) {
    assert.deepEqual(copy.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all(), db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all(), table);
  }
});

test('schema changes and tables without a primary key request a full base rewrite', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE a(id INTEGER PRIMARY KEY,v TEXT)');
  const tracker = new ChangeTracker(db);
  db.exec('CREATE TABLE b(id INTEGER PRIMARY KEY)');
  assert.equal(tracker.collect(db).fullRewrite, true);
  const loose = new DatabaseSync(':memory:');
  loose.exec('CREATE TABLE log(message TEXT)');
  assert.equal(new ChangeTracker(loose).collect(loose).fullRewrite, true);
});

test('a write sends only its changed rows and readers fetch only newer journal rows', async () => {
  const pool = new PglitePool();
  try {
    const writer = new SnapshotRepository(pool), reader = new SnapshotRepository(pool);
    await writer.withStore(true, async store => { seed(store, 200); });
    assert.equal(writer.transfer.baseWrites, 1, 'creating the schema writes the first base');
    const baseBytes = writer.transfer.baseBytesWritten;
    assert.equal(await reader.withStore(false, async store => Number(store.db.prepare('SELECT COUNT(*) n FROM performances').get()!.n)), 200);
    assert.equal(reader.transfer.baseReads, 1);

    await writer.withStore(true, async store => { store.upsert(performance(7, 'TEST renamed')); });
    assert.equal(writer.transfer.baseWrites, 1, 'a one-row change does not rewrite the base');
    assert.ok(writer.transfer.journalRowsWritten <= 2, `wrote ${writer.transfer.journalRowsWritten} journal rows`);
    assert.ok(writer.transfer.journalBytesWritten < baseBytes / 20);

    assert.ok((await reader.withStore(false, async store => titles(store))).includes('TEST renamed'));
    assert.equal(reader.transfer.baseReads, 1, 'a warm reader applies the journal instead of downloading the base again');
    assert.ok(reader.transfer.journalRowsRead <= 2);

    const cold = new SnapshotRepository(pool);
    assert.ok((await cold.withStore(false, async store => titles(store))).includes('TEST renamed'), 'a cold reader combines base and journal');

    const before = { ...writer.transfer }, writes = pool.writes;
    await writer.withStore(true, async store => { store.upsert(performance(8)); });
    assert.equal(writer.transfer.journalRowsWritten, before.journalRowsWritten, 'repeating identical provider data writes nothing');
    assert.equal(pool.writes, writes, 'and commits no revision');
  } finally { await pool.close(); }
});

test('a request that changes nothing does not create a revision', async () => {
  const pool = new PglitePool();
  try {
    const repo = new SnapshotRepository(pool);
    await repo.withStore(true, async store => { seed(store, 3); });
    const writes = pool.writes;
    await repo.withStore(true, async store => store.search({ limit: '5' } as any));
    assert.equal(pool.writes, writes);
    assert.equal((await pool.sql('SELECT revision FROM culture_desk_state'))[0].revision, 1);
  } finally { await pool.close(); }
});

test('the journal is folded into a new base once it outgrows the base, and stale readers reload', async () => {
  const pool = new PglitePool();
  try {
    const writer = new SnapshotRepository(pool), reader = new SnapshotRepository(pool);
    await writer.withStore(true, async store => { seed(store, 20); });
    await reader.withStore(false, async store => titles(store));
    const big = 'x'.repeat(4000);
    let n = 1000;
    while (writer.transfer.baseWrites < 2) {
      await writer.withStore(true, async store => store.transaction(() => { for (let i = 0; i < 100; i++) store.upsert({ ...performance(n++), description: big } as any); }));
      assert.ok(n < 1000 + 100 * Math.ceil((2 * MIN_COMPACTION_BYTES) / (100 * 4000)) + 200, 'compaction must happen');
    }
    assert.equal((await pool.sql('SELECT COUNT(*)::int AS n FROM culture_desk_delta'))[0].n, 0);
    const state = (await pool.sql('SELECT revision,base_revision FROM culture_desk_state'))[0];
    assert.equal(Number(state.revision), Number(state.base_revision));
    const count = await reader.withStore(false, async store => Number(store.db.prepare('SELECT COUNT(*) n FROM performances').get()!.n));
    assert.equal(count, n - 1000 + 20);
    assert.equal(reader.transfer.baseReads, 2, 'a reader older than the new base downloads it once');
  } finally { await pool.close(); }
});

test('concurrent writers are serialized and both changes survive; a failed commit changes nothing', async () => {
  const pool = new PglitePool();
  try {
    const one = new SnapshotRepository(pool), two = new SnapshotRepository(pool);
    await one.withStore(true, async store => { seed(store, 5); });
    await Promise.all([
      one.withStore(true, async store => { store.upsert(performance(100)); await new Promise(resolve => setTimeout(resolve, 30)); }),
      two.withStore(true, async store => { store.upsert(performance(101)); }),
    ]);
    assert.equal(pool.maxActive, 1);
    const fresh = new SnapshotRepository(pool);
    assert.deepEqual(await fresh.withStore(false, async store => titles(store).filter(title => /10[01]$/.test(title))), ['TEST performance 100', 'TEST performance 101']);
    pool.failOn = /INSERT INTO culture_desk_delta/;
    await assert.rejects(one.withStore(true, async store => { store.upsert(performance(102)); }), /simulated persistence failure/);
    assert.equal((await fresh.withStore(false, async store => titles(store))).includes('TEST performance 102'), false);
    assert.equal((await one.withStore(false, async store => titles(store))).includes('TEST performance 102'), false, 'the failed writer cache is not reused');
  } finally { await pool.close(); }
});

test('the first start moves the legacy single-row snapshot inside the database without changing it', async () => {
  const pool = new PglitePool();
  const folder = mkdtempSync(path.join(os.tmpdir(), 'culture-legacy-'));
  try {
    const legacy = new Store(path.join(folder, 'legacy.db'), NATIONAL_CITIES);
    seed(legacy, 4); legacy.backup(path.join(folder, 'copy.db')); legacy.close();
    const bytes = gzipSync(readFileSync(path.join(folder, 'copy.db')));
    await pool.sql('CREATE TABLE culture_desk_snapshot(id SMALLINT PRIMARY KEY,data BYTEA,revision BIGINT NOT NULL DEFAULT 0)');
    await pool.sql('INSERT INTO culture_desk_snapshot VALUES(1,$1,41)', [bytes]);
    const repo = new SnapshotRepository(pool);
    assert.equal(await repo.withStore(false, async store => titles(store).length), 4);
    await repo.withStore(true, async store => { store.upsert(performance(9)); });
    assert.equal(Buffer.compare(Buffer.from((await pool.sql('SELECT data FROM culture_desk_snapshot'))[0].data), bytes), 0, 'the legacy row is untouched');
    assert.equal(await new SnapshotRepository(pool).withStore(false, async store => titles(store).length), 5);
  } finally { await pool.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('a daily import of mostly unchanged performances writes only the changed rows', async () => {
  const pool = new PglitePool();
  const folder = mkdtempSync(path.join(os.tmpdir(), 'culture-import-'));
  try {
    const repo = new SnapshotRepository(pool);
    await repo.withStore(true, async store => { seed(store, 300); });
    const checkpoint = new Store(path.join(folder, 'checkpoint.db'), NATIONAL_CITIES);
    seed(checkpoint, 300);
    checkpoint.upsert(performance(3, 'TEST changed title'));
    checkpoint.upsert(performance(400));
    checkpoint.db.exec("UPDATE performances SET updated_at='2999-01-01T00:00:00.000Z'");
    checkpoint.close();
    const source = new DatabaseSync(path.join(folder, 'checkpoint.db'), { readOnly: true });
    const before = repo.transfer.journalRowsWritten;
    try { await repo.withStore(true, async store => importCollection(source, store, 'TEST_daily')); } finally { source.close(); }
    const written = repo.transfer.journalRowsWritten - before;
    assert.ok(written <= 6, `wrote ${written} journal rows for 2 changed performances`);
    assert.ok((await new SnapshotRepository(pool).withStore(false, async store => titles(store))).includes('TEST changed title'));
  } finally { await pool.close(); rmSync(folder, { recursive: true, force: true }); }
});
