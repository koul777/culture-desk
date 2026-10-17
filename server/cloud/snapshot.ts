import { Pool, type PoolClient } from 'pg';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../store.js';
import { NATIONAL_CITIES } from '../providers/cities.js';
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { ChangeTracker, applyJournal, type JournalRow } from './row-journal.js';

export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
export const MAX_DATABASE_BYTES = 128 * 1024 * 1024;
/** The journal is folded into a new base once it outgrows the compressed base (minimum 1 MiB). */
export const MIN_COMPACTION_BYTES = 1024 * 1024;
const SQLITE_HEADER = Buffer.from('SQLite format 3\0');
const BATCH_ROWS = 1000;
const BATCH_BYTES = 2 * 1024 * 1024;

/** Older deployments stored plain SQLite. New snapshots compress repeated provider data losslessly. */
export function encodeSnapshot(database: Buffer): Buffer {
  if(database.byteLength>MAX_DATABASE_BYTES)throw new SnapshotCapacityError();
  const compressed=gzipSync(database,{level:6});
  if(compressed.byteLength>MAX_SNAPSHOT_BYTES)throw new SnapshotCapacityError();
  return compressed;
}
export function decodeSnapshot(snapshot: Buffer): Buffer {
  if(snapshot.byteLength>MAX_SNAPSHOT_BYTES)throw new SnapshotCapacityError();
  const compressed=snapshot[0]===0x1f&&snapshot[1]===0x8b;
  const database=compressed?gunzipSync(snapshot,{maxOutputLength:MAX_DATABASE_BYTES}):snapshot;
  if(database.byteLength>MAX_DATABASE_BYTES)throw new SnapshotCapacityError();
  if(!database.subarray(0,SQLITE_HEADER.length).equals(SQLITE_HEADER))throw new Error('Invalid database snapshot');
  return database;
}
export class SnapshotCapacityError extends Error {
  readonly code = 'SNAPSHOT_CAPACITY';
  constructor() { super('Cloud snapshot capacity exceeded'); this.name = 'SnapshotCapacityError'; }
}
export interface SnapshotClient {
  query(text: string, values?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>;
  release(): void;
}
export interface SnapshotPool { connect(): Promise<SnapshotClient> }

/**
 * Storage layout (PostgreSQL):
 * - culture_desk_base: one gzip SQLite snapshot at `revision`.
 * - culture_desk_delta: the latest version of every row changed after the base, keyed by
 *   table and primary key (`data` NULL marks a deletion).
 * - culture_desk_state: the current revision and its commit id, the base revision and the journal size.
 * - culture_desk_commit: the commit id of every revision since the base. A cached copy is only
 *   brought forward incrementally when its own revision still has the same commit id, so a
 *   restored (rolled back) database can never be mixed with a copy from the discarded history.
 * A write locks the state row, sends only its changed rows and bumps the revision.
 * Readers keep a materialized copy and fetch only journal rows newer than it.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS culture_desk_state(id SMALLINT PRIMARY KEY CHECK(id=1),revision BIGINT NOT NULL DEFAULT 0,
    commit_id TEXT NOT NULL DEFAULT '',base_revision BIGINT NOT NULL DEFAULT 0,base_bytes BIGINT NOT NULL DEFAULT 0,
    delta_bytes BIGINT NOT NULL DEFAULT 0,updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  'CREATE TABLE IF NOT EXISTS culture_desk_commit(rev BIGINT PRIMARY KEY,id TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS culture_desk_base(id SMALLINT PRIMARY KEY CHECK(id=1),revision BIGINT NOT NULL DEFAULT 0,data BYTEA,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS culture_desk_delta(tbl TEXT NOT NULL,pk TEXT NOT NULL,rev BIGINT NOT NULL,data TEXT,PRIMARY KEY(tbl,pk))`,
  'CREATE INDEX IF NOT EXISTS culture_desk_delta_rev ON culture_desk_delta(rev)',
];
interface State { revision: number; commitId: string; baseRevision: number; baseBytes: number; deltaBytes: number; cachedCommitId: string | null }
interface Materialized { revision: number; commitId: string; database: Buffer }
export interface SnapshotTransfer { baseReads: number; baseBytesRead: number; journalRowsRead: number; journalBytesRead: number;
  baseWrites: number; baseBytesWritten: number; journalRowsWritten: number; journalBytesWritten: number }
const emptyTransfer = (): SnapshotTransfer => ({ baseReads: 0, baseBytesRead: 0, journalRowsRead: 0, journalBytesRead: 0,
  baseWrites: 0, baseBytesWritten: 0, journalRowsWritten: 0, journalBytesWritten: 0 });
const toBuffer = (value: unknown): Buffer | null => value === null || value === undefined ? null : Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
const readState = (row: any): State => ({ revision: Number(row.revision), commitId: String(row.commit_id ?? ''), baseRevision: Number(row.base_revision),
  baseBytes: Number(row.base_bytes ?? 0), deltaBytes: Number(row.delta_bytes ?? 0), cachedCommitId: row.cached_commit_id === null || row.cached_commit_id === undefined ? null : String(row.cached_commit_id) });
// The commit id recorded for the cached revision travels in the same round trip as the state.
const STATE_SQL = `SELECT revision,commit_id,base_revision,base_bytes,delta_bytes,
  (SELECT id FROM culture_desk_commit WHERE rev=$1) AS cached_commit_id FROM culture_desk_state WHERE id=1`;
const RETIRE_LEGACY = [
  `CREATE OR REPLACE FUNCTION culture_desk_snapshot_retired() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'culture_desk_snapshot is retired; data moved to culture_desk_base' USING ERRCODE='55000'; END $$`,
  'DROP TRIGGER IF EXISTS culture_desk_snapshot_retired ON culture_desk_snapshot',
  // Old readers keep working; an old writer fails loudly instead of writing to a table nobody reads.
  `CREATE TRIGGER culture_desk_snapshot_retired BEFORE UPDATE OR DELETE ON culture_desk_snapshot
    FOR EACH ROW EXECUTE FUNCTION culture_desk_snapshot_retired()`,
];

/** All writers hold the same PostgreSQL row lock from hydration to commit. */
export class SnapshotRepository {
  private ready?: Promise<void>;
  // Validated against the committed revision on every request. A TTL-only cache could
  // hide newly collected records or a pause written by another instance.
  private readCache?: Materialized;
  /** Bytes crossing the database boundary, for verification and benchmarks. */
  readonly transfer: SnapshotTransfer = emptyTransfer();
  constructor(private readonly pool: SnapshotPool) {}
  async initialize(): Promise<void> {
    if (!this.ready) this.ready = (async () => {
      const client = await this.pool.connect();
      let transaction = false;
      try {
        // Normal cold starts only look: DDL would queue behind an open writer's table lock.
        const ready = (await client.query(`SELECT to_regclass('culture_desk_commit') IS NOT NULL AND to_regclass('culture_desk_delta_rev') IS NOT NULL
          AND to_regclass('culture_desk_state') IS NOT NULL AS ready`)).rows[0]?.ready;
        if (ready && (await client.query('SELECT 1 FROM culture_desk_state WHERE id=1')).rows.length) return;
        await client.query('BEGIN'); transaction = true;
        await client.query("SET LOCAL lock_timeout='15s'");
        await client.query('SELECT pg_advisory_xact_lock(73490822)');
        for (const statement of SCHEMA) await client.query(statement);
        if (!(await client.query('SELECT 1 FROM culture_desk_state WHERE id=1')).rows.length) {
          // One-time move from the single-row snapshot table. The copy stays inside the database
          // server. The legacy row is locked first, so an in-flight old writer finishes before the
          // copy, and then retired: it stays readable for rollback but rejects further writes.
          const legacy = (await client.query("SELECT to_regclass('culture_desk_snapshot') IS NOT NULL AS present")).rows[0]?.present;
          if (legacy) {
            await client.query('SELECT 1 FROM culture_desk_snapshot WHERE id=1 FOR UPDATE');
            await client.query('INSERT INTO culture_desk_base(id,revision,data) SELECT 1,0,data FROM culture_desk_snapshot WHERE id=1 ON CONFLICT DO NOTHING');
            for (const statement of RETIRE_LEGACY) await client.query(statement);
          }
          await client.query('INSERT INTO culture_desk_base(id) VALUES(1) ON CONFLICT DO NOTHING');
          await client.query('INSERT INTO culture_desk_state(id,base_bytes) SELECT 1,COALESCE(octet_length(data),0) FROM culture_desk_base WHERE id=1 ON CONFLICT DO NOTHING');
        }
        await client.query('COMMIT'); transaction = false;
      } catch (error) {
        if (transaction) await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    })().catch(error => { this.ready = undefined; throw error; });
    return this.ready;
  }
  async withStore<T>(write: boolean, operation: (store: Store) => Promise<T>, _options: { skipUnchanged?: boolean } = {}): Promise<T> {
    await this.initialize();
    const client = await this.pool.connect();
    let store: Store | undefined;
    let folder: string | undefined;
    let transaction = false;
    try {
      folder = await mkdtemp(path.join(os.tmpdir(), 'culture-cloud-'));
      let state: State;
      if (write) {
        await client.query('BEGIN'); transaction = true;
        await client.query("SET LOCAL lock_timeout='8s'; SET LOCAL statement_timeout='20s'; SET LOCAL idle_in_transaction_session_timeout='30s'");
        state = readState((await client.query(STATE_SQL + ' FOR UPDATE', [this.readCache?.revision ?? -1])).rows[0]);
      } else {
        state = readState((await client.query(STATE_SQL, [this.readCache?.revision ?? -1])).rows[0]);
      }
      const current = await this.materialize(client, state, folder, write);
      const filename = path.join(folder, 'working.db');
      await writeFile(filename, current.database);
      let tracker: ChangeTracker | undefined;
      store = new Store(filename, NATIONAL_CITIES, { recoverRunning: false, ...(write ? { onOpen: db => { tracker = new ChangeTracker(db); } } : {}) });
      const output = await operation(store);
      if (write) {
        const changes = tracker!.collect(store.db);
        let committed: { revision: number; commitId: string } | undefined;
        if (changes.fullRewrite || changes.rows.length) {
          committed = { revision: current.revision + 1, commitId: randomUUID() };
          if (changes.fullRewrite || state.deltaBytes + changes.bytes > Math.max(MIN_COMPACTION_BYTES, state.baseBytes)) {
            await this.rewriteBase(client, store, folder, committed.revision);
          } else {
            await this.appendJournal(client, changes.rows, committed.revision);
            await client.query('UPDATE culture_desk_state SET delta_bytes=delta_bytes+$1 WHERE id=1', [changes.bytes]);
          }
          await this.recordCommit(client, committed.revision, committed.commitId);
        }
        await client.query('COMMIT'); transaction = false;
        if (committed) {
          // The working copy is exactly the committed revision; keep it for the next request.
          store.close(); store = undefined;
          this.readCache = { ...committed, database: await readFile(filename) };
        }
      }
      return output;
    } catch (error) {
      if (transaction) await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      try { store?.close(); } finally {
        client.release();
        if (folder) await removeOwnedTemp(folder);
      }
    }
  }
  /** Returns the committed database at the newest revision, fetching only what the cache lacks. */
  private async materialize(client: SnapshotClient, state: State, folder: string, locked: boolean): Promise<Materialized> {
    const cached = this.readCache;
    const current = (value: State) => !!cached && cached.revision === value.revision && cached.commitId === value.commitId;
    if (current(state)) return cached!;
    // Writers already hold the state lock. Readers need one consistent view of the tables.
    let transaction = false;
    try {
      if (!locked) {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction = true;
        state = readState((await client.query(STATE_SQL, [cached?.revision ?? -1])).rows[0]);
        if (current(state)) { await client.query('COMMIT'); transaction = false; return cached!; }
      }
      let database: Buffer;
      let from: number;
      if (cached && cached.revision >= state.baseRevision && cached.revision < state.revision && state.cachedCommitId === cached.commitId) {
        database = cached.database; from = cached.revision;
      } else {
        const base = (await client.query('SELECT revision,data FROM culture_desk_base WHERE id=1')).rows[0];
        const bytes = toBuffer(base?.data);
        this.transfer.baseReads++; this.transfer.baseBytesRead += bytes?.byteLength ?? 0;
        if (Number(base?.revision ?? 0) !== state.baseRevision) throw new Error('Cloud snapshot base does not match its state');
        database = bytes ? decodeSnapshot(bytes) : Buffer.alloc(0);
        from = state.baseRevision;
      }
      const rows: JournalRow[] = [];
      if (state.revision > from) {
        const result = await client.query('SELECT tbl,pk,data FROM culture_desk_delta WHERE rev>$1 AND rev<=$2', [from, state.revision]);
        for (const row of result.rows) {
          rows.push({ tbl: String(row.tbl), pk: String(row.pk), data: row.data === null ? null : String(row.data) });
          this.transfer.journalRowsRead++;
          this.transfer.journalBytesRead += Buffer.byteLength(String(row.tbl)) + Buffer.byteLength(String(row.pk)) + (row.data === null ? 0 : Buffer.byteLength(String(row.data)));
        }
      }
      if (transaction) { await client.query('COMMIT'); transaction = false; }
      if (rows.length) {
        const file = path.join(folder, 'materialize.db');
        await writeFile(file, database);
        const db = new DatabaseSync(file);
        try { applyJournal(db, rows); } finally { db.close(); }
        database = await readFile(file);
      }
      const materialized = { revision: state.revision, commitId: state.commitId, database };
      this.readCache = materialized;
      return materialized;
    } catch (error) {
      if (transaction) await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }
  private async appendJournal(client: SnapshotClient, rows: JournalRow[], revision: number): Promise<void> {
    for (let start = 0; start < rows.length;) {
      const batch: JournalRow[] = [];
      let bytes = 0;
      while (start < rows.length && batch.length < BATCH_ROWS && (!batch.length || bytes < BATCH_BYTES)) {
        const row = rows[start++]; batch.push(row); bytes += Buffer.byteLength(row.tbl) + Buffer.byteLength(row.pk) + (row.data === null ? 0 : Buffer.byteLength(row.data));
      }
      await client.query(`INSERT INTO culture_desk_delta(tbl,pk,rev,data)
        SELECT tbl,pk,$3::bigint,data FROM unnest($1::text[],$2::text[],$4::text[]) AS changed(tbl,pk,data)
        ON CONFLICT(tbl,pk) DO UPDATE SET rev=EXCLUDED.rev,data=EXCLUDED.data`,
      [batch.map(row => row.tbl), batch.map(row => row.pk), revision, batch.map(row => row.data)]);
      this.transfer.journalRowsWritten += batch.length; this.transfer.journalBytesWritten += bytes;
    }
  }
  /** Folds the journal into a new base. Used for schema changes and when the journal outgrows the base. */
  private async rewriteBase(client: SnapshotClient, store: Store, folder: string, revision: number): Promise<void> {
    const snapshot = path.join(folder, 'committed.db');
    store.backup(snapshot);
    const bytes = encodeSnapshot(await readFile(snapshot));
    await client.query('UPDATE culture_desk_base SET data=$1,revision=$2,updated_at=now() WHERE id=1', [bytes, revision]);
    await client.query('DELETE FROM culture_desk_delta WHERE rev<=$1', [revision]);
    await client.query('DELETE FROM culture_desk_commit WHERE rev<$1', [revision]);
    await client.query('UPDATE culture_desk_state SET base_revision=$1,base_bytes=$2,delta_bytes=0 WHERE id=1', [revision, bytes.byteLength]);
    this.transfer.baseWrites++; this.transfer.baseBytesWritten += bytes.byteLength;
  }
  private async recordCommit(client: SnapshotClient, revision: number, commitId: string): Promise<void> {
    await client.query('INSERT INTO culture_desk_commit(rev,id) VALUES($1,$2) ON CONFLICT(rev) DO UPDATE SET id=EXCLUDED.id', [revision, commitId]);
    await client.query('UPDATE culture_desk_state SET revision=$1,commit_id=$2,updated_at=now() WHERE id=1', [revision, commitId]);
  }
  /** Deployment seeding is insert-only: an existing cloud database is never replaced. */
  async seedIfEmpty(data: Buffer): Promise<boolean> {
    if(data.byteLength>MAX_DATABASE_BYTES)throw new SnapshotCapacityError();
    const folder = await mkdtemp(path.join(os.tmpdir(), 'culture-cloud-'));
    try {
      const file = path.join(folder, 'seed.db'); await writeFile(file, data);
      const check = new DatabaseSync(file, { readOnly: true });
      try {
        const row = check.prepare('PRAGMA quick_check').get();
        if (!row || Object.values(row)[0] !== 'ok') throw new Error('Invalid database snapshot');
        for (const table of ['cities','performances','bookmarks','sync_runs','sync_tasks']) {
          if (!check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error('Invalid database schema');
        }
      } finally { check.close(); }
      const encoded = encodeSnapshot(data);
      await this.initialize();
      const client = await this.pool.connect();
      let transaction = false;
      try {
        await client.query('BEGIN'); transaction = true;
        const state = readState((await client.query(STATE_SQL + ' FOR UPDATE', [-1])).rows[0]);
        const empty = (await client.query('SELECT (SELECT data IS NULL FROM culture_desk_base WHERE id=1) AND NOT EXISTS(SELECT 1 FROM culture_desk_delta) AS empty')).rows[0]?.empty;
        if (!empty) { await client.query('COMMIT'); transaction = false; return false; }
        const revision = state.revision + 1;
        await client.query('UPDATE culture_desk_base SET data=$1,revision=$2,updated_at=now() WHERE id=1', [encoded, revision]);
        await client.query('UPDATE culture_desk_state SET base_revision=$1,base_bytes=$2,delta_bytes=0 WHERE id=1', [revision, encoded.byteLength]);
        await client.query('DELETE FROM culture_desk_commit WHERE rev<$1', [revision]);
        await this.recordCommit(client, revision, randomUUID());
        await client.query('COMMIT'); transaction = false;
        this.transfer.baseWrites++; this.transfer.baseBytesWritten += encoded.byteLength;
        return true;
      } catch (error) {
        if (transaction) await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    } finally { await removeOwnedTemp(folder); }
  }
}
async function removeOwnedTemp(folder: string): Promise<void> {
  const resolved = await realpath(folder);
  const parent = await realpath(os.tmpdir());
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('culture-cloud-')) throw new Error('Invalid temporary directory');
  await rm(resolved, { recursive: true, force: true });
}
let repository: SnapshotRepository | undefined;
export function getSnapshotRepository(): SnapshotRepository {
  if (!repository) {
    const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!connectionString) throw new Error('Cloud database is not configured');
    const pool = new Pool({ connectionString, max: 3, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000, allowExitOnIdle: true });
    // A connection failure must not log a credential-bearing connection string.
    pool.on('error', () => {});
    repository = new SnapshotRepository(pool as unknown as { connect(): Promise<PoolClient> });
  }
  return repository;
}
