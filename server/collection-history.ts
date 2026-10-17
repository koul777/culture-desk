import type { DatabaseSync } from 'node:sqlite';
import type { Store } from './store.js';

export interface CollectionArchiveResult { archivedRuns: number; removedTasks: number; removedItems: number }
export interface RunSummary { tasksTotal: number; tasksDone: number; tasksFailed: number; performances: number; excluded: number; review: number; listEvidence: string }

/** Aggregate totals and per-range list evidence of one run, from any database holding its tasks and items. */
export function summarizeRun(db: DatabaseSync, runId: number): RunSummary {
  const counts = db.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN state='done' THEN 1 ELSE 0 END) done,
    SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) failed FROM sync_tasks WHERE run_id=?`).get(runId)!;
  const classified = db.prepare(`SELECT p.classification,COUNT(*) n FROM sync_items i
    JOIN performances p ON p.id=i.performance_id WHERE i.run_id=? GROUP BY p.classification`).all(runId);
  const count = (classification: string) => Number(classified.find(item => item.classification === classification)?.n || 0);
  const evidence = db.prepare(`SELECT from_date AS "from",to_date AS "to",COUNT(*) pages,
    MIN(page) firstPage,MAX(page) lastPage,SUM(attempts) attempts
    FROM sync_tasks WHERE run_id=? AND kind='list' GROUP BY from_date,to_date ORDER BY from_date,to_date`).all(runId);
  return { tasksTotal: Number(counts.total || 0), tasksDone: Number(counts.done || 0), tasksFailed: Number(counts.failed || 0),
    performances: count('performance'), excluded: count('excluded'), review: count('review'), listEvidence: JSON.stringify(evidence) };
}
export function insertRunSummary(store: Store, runId: number, summary: RunSummary): void {
  store.db.prepare(`INSERT INTO sync_run_archive(
    run_id,tasks_total,tasks_done,tasks_failed,performances,excluded,review,list_evidence,archived_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(runId, summary.tasksTotal, summary.tasksDone, summary.tasksFailed,
    summary.performances, summary.excluded, summary.review, summary.listEvidence, new Date().toISOString());
}

/** Keep coverage and audit totals, removing only old completed task/item links in one transaction.
 * Call after importCollection returns; this function owns its SQLite transaction.
 */
export function archiveCompletedCollectionRuns(store: Store, cutoff = new Date(Date.now() - 7 * 86400000)): CollectionArchiveResult {
  if (!Number.isFinite(cutoff.getTime())) throw new Error('Invalid collection archive cutoff');
  return store.transaction(() => {
    const rows = store.db.prepare(`SELECT r.id FROM sync_runs r
      WHERE r.state='complete' AND r.updated_at<?
      AND NOT EXISTS(SELECT 1 FROM sync_run_archive a WHERE a.run_id=r.id)
      AND EXISTS(SELECT 1 FROM sync_tasks t WHERE t.run_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM sync_tasks t WHERE t.run_id=r.id AND t.state!='done')`).all(cutoff.toISOString());
    const result = { archivedRuns: 0, removedTasks: 0, removedItems: 0 };
    const deleteTasks = store.db.prepare('DELETE FROM sync_tasks WHERE run_id=?');
    const deleteItems = store.db.prepare('DELETE FROM sync_items WHERE run_id=?');
    for (const row of rows) {
      insertRunSummary(store, Number(row.id), summarizeRun(store.db, Number(row.id)));
      result.removedTasks += Number(deleteTasks.run(row.id).changes);
      result.removedItems += Number(deleteItems.run(row.id).changes);
      result.archivedRuns++;
    }
    return result;
  });
}
