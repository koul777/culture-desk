import type { DatabaseSync } from 'node:sqlite';
import type { City, PerformanceInput } from '../shared/types.js';
import type { Store } from './store.js';

/** Merge a verified collection checkpoint without replacing live IDs, bookmarks, or newer detail fields. */
export function importCollection(source: DatabaseSync, target: Store, importKey: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(importKey)) throw new Error('Invalid collection identifier');
  const check = source.prepare('PRAGMA quick_check').get();
  if (Object.values(check || {})[0] !== 'ok') throw new Error('Invalid collection database');
  const rows = source.prepare('SELECT p.id,p.data,p.updated_at,s.raw FROM performances p LEFT JOIN performance_sources s ON s.performance_id=p.id').all();
  const runs = source.prepare("SELECT * FROM sync_runs WHERE state='complete' ORDER BY id").all();
  const incompleteRuns=source.prepare("SELECT * FROM sync_runs WHERE detail_only=0 AND state!='complete'").all();
  const sourceTasks = source.prepare('SELECT * FROM sync_tasks WHERE run_id=?');
  const sourceItems = source.prepare('SELECT performance_id FROM sync_items WHERE run_id=?');
  return target.transaction(() => {
    target.db.exec(`CREATE TABLE IF NOT EXISTS collection_import_runs(
      import_key TEXT NOT NULL,source_run INTEGER NOT NULL,run_id INTEGER NOT NULL REFERENCES sync_runs(id),
      PRIMARY KEY(import_key,source_run));`);
    // A newer external refresh also invalidates old coverage that predates this importer.
    // Preserve the original timestamps and tasks as historical evidence; only the coverage claim changes.
    for(const gap of incompleteRuns)target.db.prepare(`UPDATE sync_runs SET state='partial',
      error='후속 전국 수집이 진행 중이므로 이전 완료 범위만으로 전체 수집을 판단할 수 없습니다.'
      WHERE detail_only=0 AND source=? AND city_id=? AND state='complete' AND from_date<=? AND to_date>=?
      AND (created_at<? OR updated_at<?)`).run(gap.source,gap.city_id,gap.to_date,gap.from_date,gap.created_at,gap.updated_at);
    const known = new Set(target.cities().map(city => city.id));
    for (const row of source.prepare('SELECT data FROM cities').all()) {
      const city = JSON.parse(String(row.data)) as City;
      if (!known.has(city.id)) { target.addCity(city); known.add(city.id); }
    }
    const idMap = new Map<number, number>();
    let skippedItems=0;
    for (const row of rows) {
      const item = { ...JSON.parse(String(row.data)), raw: JSON.parse(String(row.raw || 'null')) } as PerformanceInput;
      const existing=target.db.prepare('SELECT id,data,updated_at FROM performances WHERE source=? AND source_id=?').get(item.source,item.sourceId);
      const old=existing?JSON.parse(String(existing.data)) as PerformanceInput:undefined;
      if(existing&&(String(existing.updated_at)>String(row.updated_at)||(old?.detailState==='complete'&&item.detailState==='failed'))){
        idMap.set(Number(row.id),Number(existing.id));skippedItems++;continue;
      }
      const targetId=target.upsert(item);
      // Retain the provider checkpoint version, not the publication time, so newer detail can merge later.
      target.db.prepare('UPDATE performances SET updated_at=? WHERE id=?').run(row.updated_at,targetId);
      idMap.set(Number(row.id),targetId);
    }
    let addedRuns = 0;
    const restoreCompletedHistory = target.db.prepare(`UPDATE sync_runs SET state='complete',error=''
      WHERE source=? AND city_id=? AND state='partial' AND detail_only=0 AND from_date<=? AND to_date>=?
      AND created_at<=? AND updated_at<=? AND error IN (
      '후속 전국 수집이 진행 중이므로 이전 완료 범위만으로 전체 수집을 판단할 수 없습니다.',
      '후속 수집이 진행 중이므로 이전 완료 범위만으로 전체 수집을 판단할 수 없습니다.')`);
    for (const run of runs) {
      const prior = target.db.prepare('SELECT run_id FROM collection_import_runs WHERE import_key=? AND source_run=?').get(importKey, run.id);
      const sourceConflict=!run.detail_only&&incompleteRuns.some(next=>next.source===run.source&&next.city_id===run.city_id
        &&String(next.from_date)<=String(run.to_date)&&String(next.to_date)>=String(run.from_date)
        &&(String(next.created_at)>String(run.created_at)||String(next.updated_at)>String(run.updated_at)));
      const liveConflict=!run.detail_only&&target.db.prepare(`SELECT id FROM sync_runs WHERE source=? AND city_id=? AND detail_only=0
        AND state!='complete' AND from_date<=? AND to_date>=? AND (created_at>? OR updated_at>?) LIMIT 1`)
        .get(run.source,run.city_id,run.to_date,run.from_date,run.created_at,run.updated_at);
      if(sourceConflict||liveConflict){
        if(prior)target.db.prepare("UPDATE sync_runs SET state='partial',error='후속 수집이 진행 중이므로 이전 완료 범위만으로 전체 수집을 판단할 수 없습니다.' WHERE id=?").run(prior.run_id);
        continue;
      }
      // A successfully refreshed range resolves this importer's temporary coverage warning.
      // Restore only previously completed history, never an actual failed or partially collected run.
      if(!run.detail_only)restoreCompletedHistory.run(run.source,run.city_id,run.to_date,run.from_date,run.created_at,run.updated_at);
      if(prior){
        target.db.prepare("UPDATE sync_runs SET state='complete',error='',updated_at=? WHERE id=?").run(run.updated_at,prior.run_id);
        continue;
      }
      const result = target.db.prepare(`INSERT INTO sync_runs(source,city_id,from_date,to_date,state,created_at,updated_at,error,detail_only)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(run.source,run.city_id,run.from_date,run.to_date,run.state,run.created_at,run.updated_at,run.error,run.detail_only);
      const runId = Number(result.lastInsertRowid);
      for (const task of sourceTasks.all(run.id)) target.db.prepare(`INSERT INTO sync_tasks(
        run_id,kind,task_key,source,city_id,from_date,to_date,page,source_id,state,attempts,available_at,error)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(runId,task.kind,task.task_key,task.source,task.city_id,task.from_date,task.to_date,task.page,task.source_id,task.state,task.attempts,task.available_at,task.error);
      for (const item of sourceItems.all(run.id)) {
        const itemId = idMap.get(Number(item.performance_id));
        if (itemId) target.db.prepare('INSERT OR IGNORE INTO sync_items VALUES(?,?)').run(runId,itemId);
      }
      target.db.prepare('INSERT INTO collection_import_runs VALUES(?,?,?)').run(importKey,run.id,runId);
      addedRuns++;
    }
    return { importedItems: rows.length-skippedItems, skippedNewerOrCompleteItems:skippedItems, completedSourceRuns: runs.length, addedRuns, counts: target.counts() };
  });
}
