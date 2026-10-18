/**
 * Compares database traffic of the previous single-snapshot storage with the base + row journal
 * storage, using the 5,615 real public records bundled in server/assets/public-snapshot.json.gz.
 * Runs entirely locally against PGlite (an in-process PostgreSQL); no credentials or network.
 *
 *   node --import tsx scripts/benchmark-storage-volume.ts [output.json]
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { PglitePool } from '../tests/helpers/pglite-pool.js';
import { SnapshotRepository } from '../server/cloud/snapshot.js';
import { Store } from '../server/store.js';
import { NATIONAL_CITIES } from '../server/providers/cities.js';
import { importCollection } from '../server/import-collection.js';
import type { PerformanceInput } from '../shared/types.js';

const snapshot = JSON.parse(gunzipSync(readFileSync(path.resolve('server/assets/public-snapshot.json.gz'))).toString());
const records = (snapshot.performances as any[]).map(({ id: _id, updatedAt: _updated, bookmarked: _b, note: _n, ...item }) =>
  ({ ...item, classification: 'performance', raw: { provider: item.source, record: item } }) as PerformanceInput);
const folder = mkdtempSync(path.join(os.tmpdir(), 'culture-volume-'));
const window = { from: '2026-10-01', to: '2027-01-16' };

/** A collector checkpoint: every region/source run complete, with list tasks and linked items. */
function checkpoint(file: string, items: PerformanceInput[], stamp: string): void {
  const store = new Store(file, NATIONAL_CITIES);
  store.transaction(() => {
    const runs = new Map<string, number>();
    for (const city of NATIONAL_CITIES) for (const source of ['kopis', 'culture'] as const) runs.set(`${city.id}:${source}`, store.createRun(source, city.id, window.from, window.to));
    for (const item of items) {
      const run = runs.get(`${item.cityId}:${item.source}`);
      const id = store.upsert(item, run);
      if (run) store.addTask(run, item.source, item.cityId, 'detail', window.from, window.to, 1, item.sourceId);
      store.db.prepare('UPDATE performances SET updated_at=? WHERE id=?').run(stamp, id);
    }
    store.db.exec("UPDATE sync_tasks SET state='done',attempts=1; UPDATE sync_runs SET state='complete'");
  });
  store.close();
}
const gzSize = (file: string) => { const copy = file + '.copy'; const db = new DatabaseSync(file); db.prepare('VACUUM INTO ?').run(copy); db.close(); return gzipSync(readFileSync(copy), { level: 6 }).byteLength; };

const pool = new PglitePool();
try {
  // Day 1: the existing production database after the first nationwide import (full task history).
  const day1 = path.join(folder, 'day1.db');
  checkpoint(day1, records, '2026-10-16T09:00:00.000Z');
  const repo = new SnapshotRepository(pool);
  const source1 = new DatabaseSync(day1, { readOnly: true });
  await repo.withStore(true, async store => importCollection(source1, store, 'day1'));
  source1.close();
  const legacyFile = path.join(folder, 'production.db');
  await repo.withStore(false, async store => { store.backup(legacyFile); });
  const productionGz = gzSize(legacyFile);

  // Day 2: providers changed 2% of performances and the daily range moved.
  const changed = Math.round(records.length * 0.02);
  const day2Items = records.map((item, index) => index < changed ? { ...item, status: '공연중', title: `${item.title} (변경)` } : item);
  const day2 = path.join(folder, 'day2.db');
  checkpoint(day2, day2Items, '2026-10-17T09:00:00.000Z');
  const checkpointGz = gzSize(day2);

  const warm = new SnapshotRepository(pool);
  await warm.withStore(false, async () => undefined);
  const before = { ...repo.transfer };
  const source2 = new DatabaseSync(day2, { readOnly: true });
  await repo.withStore(true, async store => importCollection(source2, store, 'day2', { summarizeCompletedRuns: true }));
  source2.close();
  const warmBefore = { ...warm.transfer };
  await warm.withStore(false, async () => undefined);
  const cold = new SnapshotRepository(pool);
  await cold.withStore(false, async () => undefined);

  // The previous runner merged into production every 2 minutes (about 20 times in a 40-minute run),
  // and every merge read and rewrote the whole compressed database. Each checkpoint was also saved.
  const previousMerges = 20;
  const result = {
    dataset: { performances: records.length, changedPerformances: changed, regions: NATIONAL_CITIES.length, sourceRuns: NATIONAL_CITIES.length * 2 },
    compressedProductionBytes: productionGz,
    compressedCheckpointBytes: checkpointGz,
    previousDailyRefresh: {
      merges: previousMerges,
      bytesReadFromDatabase: previousMerges * productionGz,
      bytesWrittenToDatabase: previousMerges * (productionGz + checkpointGz),
    },
    newDailyRefresh: {
      merges: 1,
      checkpointSaves: 4,
      journalRowsWritten: repo.transfer.journalRowsWritten - before.journalRowsWritten,
      journalBytesWritten: repo.transfer.journalBytesWritten - before.journalBytesWritten,
      baseRewrites: repo.transfer.baseWrites - before.baseWrites,
      bytesWrittenToDatabase: (repo.transfer.journalBytesWritten - before.journalBytesWritten) + (repo.transfer.baseBytesWritten - before.baseBytesWritten) + 4 * checkpointGz,
      // The runner is a fresh process: it materializes the database once (base + journal).
      bytesReadFromDatabase: cold.transfer.baseBytesRead + cold.transfer.journalBytesRead,
    },
    readers: {
      previousEveryReadAfterAnyChange: productionGz,
      newWarmInstanceAfterDailyRefresh: (warm.transfer.journalBytesRead - warmBefore.journalBytesRead) + (warm.transfer.baseBytesRead - warmBefore.baseBytesRead),
      newColdInstance: cold.transfer.baseBytesRead + cold.transfer.journalBytesRead,
      newUnchangedRead: 0,
    },
  };
  const output = process.argv[2];
  if (output) writeFileSync(path.resolve(output), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.close();
  rmSync(folder, { recursive: true, force: true });
}
