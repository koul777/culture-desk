import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { NATIONAL_CITIES } from '../server/providers/cities.js';
import { RefreshJobRepository, auditRefreshCheckpoint, refreshWindow, safeRefreshError, LeaseLostError } from '../server/cloud/refresh-jobs.js';
import type { SnapshotPool, SnapshotClient } from '../server/cloud/snapshot.js';

test('rolling range uses Korea date and clamps a three-month target at month end', () => {
  assert.deepEqual(refreshWindow(new Date('2026-10-15T15:01:00Z')), { day: '2026-10-16', from: '2026-10-01', to: '2027-01-16' });
  assert.deepEqual(refreshWindow(new Date('2026-11-30T02:00:00Z')), { day: '2026-11-30', from: '2026-11-01', to: '2027-02-28' });
});
test('nationwide completion requires all 460 source-region runs and each date chunk task', () => {
  const store = new Store(':memory:', NATIONAL_CITIES);
  const window = { day: '2026-10-16', from: '2026-10-01', to: '2027-01-16' };
  try {
    for (const city of NATIONAL_CITIES) for (const source of ['kopis', 'culture'] as const) store.createRun(source, city.id, window.from, window.to);
    assert.equal(auditRefreshCheckpoint(store.db, window).complete, false);
    store.db.exec("UPDATE sync_tasks SET state='done'; UPDATE sync_runs SET state='complete'");
    const audit = auditRefreshCheckpoint(store.db, window);
    assert.equal(audit.complete, true); assert.equal(audit.counts.completeRuns, 460); assert.equal(audit.counts.remaining, 0);
    store.db.exec('DELETE FROM sync_tasks WHERE id=(SELECT MIN(id) FROM sync_tasks)');
    assert.equal(auditRefreshCheckpoint(store.db, window).complete, false, 'a claimed complete run with a missing page-one chunk is incomplete');
  } finally { store.close(); }
});
test('failed detail task cannot pass the completion audit even when run claims complete', () => {
  const store = new Store(':memory:', NATIONAL_CITIES);
  const window = { day: '2026-10-16', from: '2026-10-16', to: '2026-10-16' };
  try {
    let id = 0;
    for (const city of NATIONAL_CITIES) for (const source of ['kopis', 'culture'] as const) id = store.createRun(source, city.id, window.from, window.to);
    store.addTask(id, 'culture', NATIONAL_CITIES.at(-1)!.id, 'detail', window.from, window.to, 1, 'fixture');
    store.db.exec("UPDATE sync_runs SET state='complete'; UPDATE sync_tasks SET state=CASE WHEN kind='detail' THEN 'failed' ELSE 'done' END");
    const audit = auditRefreshCheckpoint(store.db, window);
    assert.equal(audit.complete, false); assert.equal(audit.counts.remaining, 1);
  } finally { store.close(); }
});
test('provider or database errors never expose credentials in persisted public messages', () => {
  for (const error of [new Error('postgres://user:SECRET@host/db?key=SECRET'), { kind: 'auth', message: 'https://api?service=SECRET' }, { kind: 'quota', message: 'SECRET' }]) {
    assert.ok(!safeRefreshError(error).includes('SECRET'));
  }
});

// Models PostgreSQL transaction serialization and lease fencing, including expired-owner writes.
class LeasePool implements SnapshotPool {
  rows = new Map<string, any>(); now = 1_000_000; pending: Promise<void> = Promise.resolve();
  get row(): any { return [...this.rows.values()].at(-1); }
  async connect(): Promise<SnapshotClient> {
    let unlock: (() => void) | undefined;
    const pool = this;
    return { async query(sql, values = []) {
      if (sql.includes('pg_advisory_xact_lock')) { const prior = pool.pending; pool.pending = new Promise<void>(r => { unlock = r; }); await prior; }
      if (sql === 'COMMIT' || sql === 'ROLLBACK') { unlock?.(); unlock = undefined; return { rows: [] }; }
      if (sql.startsWith('INSERT INTO culture_refresh_job')) {
        if (!pool.rows.has(values[0])) { pool.rows.set(values[0], { day: values[0], from_date: values[1], to_date: values[2], status: sql.includes("'complete'") ? 'complete' : 'retry_wait', checkpoint: null, counts: null, lease_until: null }); return { rows: [], rowCount: 1 }; }
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith('SELECT day')) {
        const row = [...pool.rows.values()].find(row => row.status === 'running' && row.lease_until > pool.now);
        return { rows: row ? [row] : [] };
      }
      if (sql.startsWith('SELECT *')) {
        assert.ok(sql.includes('day::text AS day') && sql.includes('from_date::text AS from_date') && sql.includes('to_date::text AS to_date'), 'DATE columns must not be parsed through the runner timezone');
        const row = pool.rows.get(values[0]);
        return { rows: row ? [{ ...row }] : [] };
      }
      if (sql.startsWith('UPDATE culture_refresh_job')) {
        if (sql.includes("SET status='failed'")) {
          for (const row of pool.rows.values()) if (row.day < values[0] && !['complete', 'failed'].includes(row.status)) { row.status = 'failed'; row.lease_owner = null; row.lease_until = null; }
          return { rows: [] };
        }
        if (sql.includes('SET checkpoint=NULL')) {
          const cutoff = new Date(values[0] + 'T00:00:00Z'); cutoff.setUTCDate(cutoff.getUTCDate() - 7);
          for (const row of pool.rows.values()) if (row.status === 'complete' || row.day < cutoff.toISOString().slice(0, 10)) row.checkpoint = null;
          return { rows: [] };
        }
        const row = pool.rows.get(values[0]);
        if (sql.includes('RETURNING *')) {
          assert.ok(sql.includes('day::text AS day') && sql.includes('from_date::text AS from_date') && sql.includes('to_date::text AS to_date'));
          if (row.lease_until && row.lease_until > pool.now) return { rows: [], rowCount: 0 };
          row.status = 'running'; row.lease_owner = values[1]; row.lease_until = pool.now + 120000;
          return { rows: [{ ...row }], rowCount: 1 };
        }
        assert.ok(sql.includes('lease_owner=$2') && sql.includes('lease_until>now()'), 'all mutations must fence expired owners');
        if (row.lease_owner !== values[1] || row.lease_until <= pool.now) return { rows: [], rowCount: 0 };
        if (sql.includes('SET lease_until')) row.lease_until = pool.now + 120000;
        if (sql.includes('SET checkpoint=$3')) { row.checkpoint = values[2]; row.counts = JSON.parse(values[3]); }
        if (sql.includes('SET status=$3')) { row.status = values[2]; row.lease_owner = null; row.lease_until = null; if (row.status === 'complete') row.checkpoint = null; }
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    }, release() { assert.equal(unlock, undefined); } };
  }
}
test('concurrent runners acquire only one lease and a completed day is skipped', async () => {
  const pool = new LeasePool(); const repo = new RefreshJobRepository(pool);
  const window = refreshWindow(new Date('2026-10-16T00:00:00Z'));
  const claims = await Promise.all([repo.acquire(window, 'runner-a'), repo.acquire(window, 'runner-b')]);
  assert.deepEqual(claims.map(result => result.state).sort(), ['acquired', 'busy']);
  await repo.finish(window.day, pool.row.lease_owner, true);
  assert.equal((await repo.acquire(window, 'runner-c')).state, 'complete');
});
test('expired runner cannot heartbeat or complete after another runner resumes its checkpoint', async () => {
  const pool = new LeasePool(); const repo = new RefreshJobRepository(pool);
  const window = refreshWindow(new Date('2026-10-16T00:00:00Z'));
  await repo.acquire(window, 'old'); pool.now += 121000;
  assert.equal((await repo.acquire(window, 'new')).state, 'acquired');
  await assert.rejects(repo.heartbeat(window.day, 'old'), LeaseLostError);
  await assert.rejects(repo.finish(window.day, 'old', true), LeaseLostError);
  await repo.heartbeat(window.day, 'new');
});
test('a live lease blocks another date; expired previous-day failures do not starve today', async () => {
  const pool = new LeasePool(); const repo = new RefreshJobRepository(pool);
  const yesterday = refreshWindow(new Date('2026-10-15T00:00:00Z'));
  const today = refreshWindow(new Date('2026-10-16T00:00:00Z'));
  await repo.acquire(yesterday, 'yesterday-runner');
  pool.row.checkpoint = Buffer.from('recoverable old state');
  assert.equal((await repo.acquire(today, 'today-runner')).state, 'busy');
  assert.equal(pool.rows.has(today.day), false);
  pool.now += 121000;
  const claim = await repo.acquire(today, 'today-runner');
  assert.equal(claim.state, 'acquired');
  if (claim.state === 'acquired') { assert.equal(claim.job.day, today.day); assert.equal(claim.job.checkpoint, null); }
  assert.equal(pool.rows.get(yesterday.day).status, 'failed');
  assert.ok(pool.rows.get(yesterday.day).checkpoint, 'recent failed evidence remains available');
});
test('completion frees checkpoint bytes and expired failure retention preserves metadata', async () => {
  const pool = new LeasePool(); const repo = new RefreshJobRepository(pool);
  const old = refreshWindow(new Date('2026-10-01T00:00:00Z'));
  const today = refreshWindow(new Date('2026-10-16T00:00:00Z'));
  await repo.acquire(old, 'old'); pool.row.checkpoint = Buffer.from('old bytes');
  await repo.finish(old.day, 'old', false);
  await repo.acquire(today, 'new');
  assert.equal(pool.rows.get(old.day).checkpoint, null); assert.equal(pool.rows.get(old.day).status, 'failed');
  pool.row.checkpoint = Buffer.from('current bytes');
  await repo.finish(today.day, 'new', true);
  assert.equal(pool.row.checkpoint, null); assert.equal(pool.rows.size, 2);
});
