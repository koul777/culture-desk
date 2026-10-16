import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readNationalBatch } from './national-config.js';

// Recover proven transient HTTP/network failures without resetting live tasks or completed work.
// Two delayed recovery rounds per task are durable, including across collector restarts.
export function retryTransientCollectionFailures(db: DatabaseSync, now = Date.now()) {
  db.exec('PRAGMA busy_timeout=5000');
  db.exec(`CREATE TABLE IF NOT EXISTS collection_retries (
    task_id INTEGER PRIMARY KEY, rounds INTEGER NOT NULL, updated_at TEXT NOT NULL)`);
  db.exec('BEGIN IMMEDIATE');
  try {
    const failed = db.prepare(`SELECT t.id,t.run_id,t.kind,t.city_id FROM sync_tasks t
      LEFT JOIN collection_retries c ON c.task_id=t.id
      WHERE t.state='failed' AND t.error LIKE '제공기관 연결에 실패했습니다.%'
      AND COALESCE(c.rounds,0)<2`).all();
    const availableAt = new Date(now + 10000).toISOString();
    for (const task of failed) {
      db.prepare("UPDATE sync_tasks SET state='queued',attempts=0,available_at=?,error='' WHERE id=? AND state='failed'").run(availableAt, task.id);
      db.prepare(`INSERT INTO collection_retries VALUES(?,1,?) ON CONFLICT(task_id)
        DO UPDATE SET rounds=rounds+1,updated_at=excluded.updated_at`).run(task.id, new Date(now).toISOString());
      db.prepare("UPDATE sync_runs SET state=CASE WHEN state='partial' THEN 'queued' ELSE state END,error='',updated_at=? WHERE id=?").run(new Date(now).toISOString(), task.run_id);
    }
    db.exec('COMMIT');
    return { requeued: failed.length, availableAt, tasks: failed };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = new DatabaseSync(readNationalBatch().filename);
  try { console.log(JSON.stringify(retryTransientCollectionFailures(db))); }
  finally { db.close(); }
}
