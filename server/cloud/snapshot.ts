import { Pool, type PoolClient } from 'pg';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../store.js';
import { NATIONAL_CITIES } from '../providers/cities.js';
import { gzipSync, gunzipSync } from 'node:zlib';
import { SnapshotCapacityError } from './snapshot-errors.js';
export { SnapshotCapacityError } from './snapshot-errors.js';

export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
export const MAX_DATABASE_BYTES = 128 * 1024 * 1024;
const SQLITE_HEADER = Buffer.from('SQLite format 3\0');

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
export interface SnapshotClient {
  query(text: string, values?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>;
  release(): void;
}
export interface SnapshotPool { connect(): Promise<SnapshotClient> }
const SCHEMA = `CREATE TABLE IF NOT EXISTS culture_desk_snapshot (
  id SMALLINT PRIMARY KEY CHECK (id=1), data BYTEA, revision BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
  INSERT INTO culture_desk_snapshot(id) VALUES(1) ON CONFLICT DO NOTHING;`;

/** All writers hold the same PostgreSQL row lock through hydration and commit. */
export class SnapshotRepository {
  private ready?: Promise<void>;
  // Validate the revision in the same SELECT as the payload. A TTL-only cache
  // could hide newly collected records or a pause from another instance.
  private readCache?: { revision: string; data: Buffer | null };
  constructor(private readonly pool: SnapshotPool) {}
  async initialize(): Promise<void> {
    if (!this.ready) this.ready = (async () => {
      const client = await this.pool.connect();
      try { await client.query(SCHEMA); } finally { client.release(); }
    })().catch(error => { this.ready = undefined; throw error; });
    return this.ready;
  }
  async withStore<T>(write: boolean, operation: (store: Store) => Promise<T>, options: { skipUnchanged?: boolean } = {}): Promise<T> {
    await this.initialize();
    const client = await this.pool.connect();
    let store: Store | undefined;
    let folder: string | undefined;
    let transaction = false;
    try {
      if (write) {
        await client.query('BEGIN'); transaction = true;
        await client.query("SET LOCAL lock_timeout='8s'; SET LOCAL statement_timeout='15s'; SET LOCAL idle_in_transaction_session_timeout='25s'");
      }
      const cached = !write ? this.readCache : undefined;
      const result = cached
        ? await client.query('SELECT CASE WHEN revision=$1::bigint THEN NULL ELSE data END AS data,revision FROM culture_desk_snapshot WHERE id=1', [cached.revision])
        : await client.query(`SELECT data,revision FROM culture_desk_snapshot WHERE id=1${write ? ' FOR UPDATE' : ''}`);
      const row = result.rows[0];
      const revision = row?.revision === undefined ? undefined : String(row.revision);
      const data = cached && revision === cached.revision ? cached.data : (row?.data ?? null) as Buffer | null;
      folder = await mkdtemp(path.join(os.tmpdir(), 'culture-cloud-'));
      const filename = path.join(folder, 'working.db');
      if (data) await writeFile(filename, decodeSnapshot(data));
      store = new Store(filename, NATIONAL_CITIES);
      if (!write && revision && /^\d+$/.test(revision)) this.readCache = { revision, data };
      // Opt-in for queue probes only. DDL by itself is not counted; callers
      // that require a schema-only commit must use the default behavior.
      const changesBefore = write && options.skipUnchanged ? store.db.prepare('SELECT total_changes() AS n').get()!.n : undefined;
      const output = await operation(store);
      if (write) {
        if (changesBefore === undefined || changesBefore !== store.db.prepare('SELECT total_changes() AS n').get()!.n) {
          const snapshot = path.join(folder, 'committed.db');
          store.backup(snapshot);
          const bytes = encodeSnapshot(await readFile(snapshot));
          await client.query('UPDATE culture_desk_snapshot SET data=$1,revision=revision+1,updated_at=now() WHERE id=1', [bytes]);
        }
        await client.query('COMMIT'); transaction = false;
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
      await this.initialize();
      const client = await this.pool.connect();
      try {
        const result = await client.query('UPDATE culture_desk_snapshot SET data=$1,revision=revision+1,updated_at=now() WHERE id=1 AND data IS NULL', [encodeSnapshot(data)]);
        return result.rowCount === 1;
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
