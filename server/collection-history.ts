import type { Store } from './store.js';

export interface CollectionArchiveResult { archivedRuns: number; removedTasks: number; removedItems: number }

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
    const tasks = store.db.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN state='done' THEN 1 ELSE 0 END) done,
      SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) failed FROM sync_tasks WHERE run_id=?`);
    const items = store.db.prepare(`SELECT p.classification,COUNT(*) n FROM sync_items i
      JOIN performances p ON p.id=i.performance_id WHERE i.run_id=? GROUP BY p.classification`);
    const evidence = store.db.prepare(`SELECT from_date AS "from",to_date AS "to",COUNT(*) pages,
      MIN(page) firstPage,MAX(page) lastPage,SUM(attempts) attempts
      FROM sync_tasks WHERE run_id=? AND kind='list' GROUP BY from_date,to_date ORDER BY from_date,to_date`);
    const insert = store.db.prepare(`INSERT INTO sync_run_archive(
      run_id,tasks_total,tasks_done,tasks_failed,performances,excluded,review,list_evidence,archived_at)
      VALUES(?,?,?,?,?,?,?,?,?)`);
    const deleteTasks = store.db.prepare('DELETE FROM sync_tasks WHERE run_id=?');
    const deleteItems = store.db.prepare('DELETE FROM sync_items WHERE run_id=?');
    for (const row of rows) {
      const counts = tasks.get(row.id)!;
      const classified = items.all(row.id);
      const count = (classification: string) => Number(classified.find(item => item.classification === classification)?.n || 0);
      insert.run(row.id, counts.total, counts.done, counts.failed, count('performance'), count('excluded'), count('review'), JSON.stringify(evidence.all(row.id)), new Date().toISOString());
      result.removedTasks += Number(deleteTasks.run(row.id).changes);
      result.removedItems += Number(deleteItems.run(row.id).changes);
      result.archivedRuns++;
    }
    return result;
  });
}
