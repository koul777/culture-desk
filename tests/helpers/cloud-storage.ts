import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../server/store.js';
import { NATIONAL_CITIES } from '../../server/providers/cities.js';
import type { PglitePool } from './pglite-pool.js';

/**
 * Everything the cloud store has committed, reduced to comparable values (the base is a digest).
 * Two equal snapshots mean no revision, base or journal row changed in between.
 */
export async function durableState(pool: PglitePool) {
  return {
    state: await pool.sql('SELECT revision::text AS revision,base_revision::text AS base_revision,base_bytes::text AS base_bytes,delta_bytes::text AS delta_bytes FROM culture_desk_state'),
    base: await pool.sql('SELECT revision::text AS revision,octet_length(data) AS bytes,md5(data) AS digest FROM culture_desk_base'),
    delta: await pool.sql('SELECT tbl,pk,rev::text AS rev,md5(data) AS digest FROM culture_desk_delta ORDER BY tbl,pk'),
  };
}

export async function committedRevision(pool: PglitePool): Promise<number> {
  return Number((await pool.sql('SELECT revision FROM culture_desk_state'))[0].revision);
}

/** A plain SQLite file as deployments stored it before compression and the journal existed. */
export function plainSqliteBytes(prepare: (store: Store) => void): Buffer {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'culture-legacy-'));
  try {
    const store = new Store(path.join(folder, 'legacy.db'), NATIONAL_CITIES);
    try { prepare(store); store.backup(path.join(folder, 'copy.db')); } finally { store.close(); }
    return readFileSync(path.join(folder, 'copy.db'));
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

/** Recreates the single-row table of the previous storage layout, holding `data` as-is. */
export async function installLegacySnapshot(pool: PglitePool, data: Buffer, revision = 41): Promise<void> {
  await pool.sql(`CREATE TABLE culture_desk_snapshot (
    id SMALLINT PRIMARY KEY CHECK (id=1), data BYTEA, revision BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.sql('INSERT INTO culture_desk_snapshot(id,data,revision) VALUES(1,$1,$2)', [data, revision]);
}
