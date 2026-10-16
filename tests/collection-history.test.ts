import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { Store } from '../server/store.js';
import { DEFAULT_CITIES } from '../server/providers/cities.js';
import { importCollection } from '../server/import-collection.js';
import { archiveCompletedCollectionRuns } from '../server/collection-history.js';
import { exportWorkbook } from '../server/export.js';
import type { PerformanceInput } from '../shared/types.js';

const old = '2026-09-01T00:00:00.000Z';
const cutoff = new Date('2026-10-09T00:00:00.000Z');
const item = (sourceId: string, classification: PerformanceInput['classification'] = 'performance'): PerformanceInput => ({
  source:'kopis',sourceId,title:'TEST performance',cityId:'andong',startDate:'2026-10-01',endDate:'2026-10-31',
  genre:'음악',sourceGenre:'music',venue:'TEST venue',address:'',poster:'',sourceUrl:'',price:'',priceType:'unknown',
  age:'',runtime:'',cast:'',producer:'',organizer:'',contact:'',schedule:'',description:'',status:'',
  detailState:'complete',classification,reviewReason:'',raw:{test:true},
});
function complete(store: Store, run: number, updatedAt = old) {
  store.db.prepare("UPDATE sync_tasks SET state='done',attempts=1 WHERE run_id=?").run(run);
  store.db.prepare("UPDATE sync_runs SET state='complete',updated_at=? WHERE id=?").run(updatedAt,run);
}
function preservedRows(store: Store) {
  return Object.fromEntries(['performances','performance_sources','bookmarks','sync_runs','collection_import_runs']
    .map(table=>[table,store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
async function workbookRows(store: Store) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await exportWorkbook(store,{cities:'andong',source:'kopis',from:'2026-10-01',to:'2026-11-30'}) as any);
  return workbook.worksheets.map(sheet=>{
    const rows=sheet.getSheetValues();
    if(sheet.name==='조회 근거') rows[2]=['timestamp omitted'];
    return rows;
  });
}

test('archiving keeps performances, private data, coverage, sync time, import mapping and Excel evidence unchanged', async t=>{
  const source=new Store(':memory:',DEFAULT_CITIES),target=new Store(':memory:',DEFAULT_CITIES);
  t.after(()=>{source.close();target.close();});
  const run=source.createRun('kopis','andong','2026-10-01','2026-11-30');
  source.addTask(run,'kopis','andong','list','2026-10-01','2026-10-31',2,'');
  source.addTask(run,'kopis','andong','detail','','',1,'TEST_PERFORMANCE');
  source.upsert(item('TEST_PERFORMANCE'),run);
  source.upsert(item('TEST_EXCLUDED','excluded'),run);
  source.upsert(item('TEST_REVIEW','review'),run);
  complete(source,run);
  importCollection(source.db,target,'TEST_ARCHIVE');
  target.bookmark(target.search({cities:'andong'}).items[0].id,true,'PRIVATE_NOTE');
  const beforeRows=preservedRows(target), beforeRuns=target.runs();
  const beforeSearch=target.search({cities:'andong',source:'kopis',from:'2026-10-01',to:'2026-11-30'});
  const beforeSync=target.lastCollectionSync('kopis'),beforeWorkbook=await workbookRows(target);
  assert.equal(beforeSearch.partial,false);

  assert.deepEqual(archiveCompletedCollectionRuns(target,cutoff),{archivedRuns:1,removedTasks:4,removedItems:3});
  assert.deepEqual(preservedRows(target),beforeRows);
  assert.deepEqual(target.runs(),beforeRuns);
  const afterSearch=target.search({cities:'andong',source:'kopis',from:'2026-10-01',to:'2026-11-30'});
  assert.deepEqual({...afterSearch,snapshotAt:''},{...beforeSearch,snapshotAt:''});
  assert.equal(target.lastCollectionSync('kopis'),beforeSync);
  assert.deepEqual(await workbookRows(target),beforeWorkbook);
  const archived=target.db.prepare('SELECT * FROM sync_run_archive').get()!;
  assert.equal(archived.tasks_total,4);
  assert.equal(archived.performances,1); assert.equal(archived.excluded,1); assert.equal(archived.review,1);
  assert.deepEqual(JSON.parse(String(archived.list_evidence)),[
    {from:'2026-10-01',to:'2026-10-31',pages:2,firstPage:1,lastPage:2,attempts:2},
    {from:'2026-11-01',to:'2026-11-30',pages:1,firstPage:1,lastPage:1,attempts:1},
  ]);
  assert.deepEqual(archiveCompletedCollectionRuns(target,cutoff),{archivedRuns:0,removedTasks:0,removedItems:0});
  assert.deepEqual(target.db.prepare('SELECT * FROM sync_run_archive').get(),archived);
  assert.equal(importCollection(source.db,target,'TEST_ARCHIVE').addedRuns,0);
  assert.equal(target.db.prepare('SELECT COUNT(*) n FROM sync_tasks').get()!.n,0);
  assert.deepEqual(target.runs(),beforeRuns);
});

test('recent, unfinished and inconsistent runs stay intact; a completed zero-result run retains its coverage proof',t=>{
  const store=new Store(':memory:',DEFAULT_CITIES);t.after(()=>store.close());
  const eligible=store.createRun('kopis','andong','2026-10-01','2026-10-31');complete(store,eligible);
  const protectedIds:number[]=[];
  for(const [index,state] of ['complete','queued','running','partial','paused','quota_wait','complete'].entries()) {
    const run=store.createRun('kopis','andong',`2026-0${index+1}-01`,`2026-0${index+1}-02`);
    store.db.prepare('UPDATE sync_runs SET state=?,updated_at=? WHERE id=?').run(state,index===0?cutoff.toISOString():old,run);
    store.db.prepare('UPDATE sync_tasks SET state=? WHERE run_id=?').run(index===0?'done':index===6?'failed':'queued',run);
    protectedIds.push(run);
  }
  const rows=store.db.prepare(`SELECT * FROM sync_tasks WHERE run_id!=? ORDER BY id`).all(eligible);
  assert.deepEqual(archiveCompletedCollectionRuns(store,cutoff),{archivedRuns:1,removedTasks:1,removedItems:0});
  assert.deepEqual(store.db.prepare(`SELECT * FROM sync_tasks WHERE run_id!=? ORDER BY id`).all(eligible),rows);
  assert.equal(store.runs(200,[eligible])[0].tasksDone,1);
  assert.equal(store.runs(200,[eligible])[0].items,0);
  assert.equal(store.runs(200,protectedIds).length,protectedIds.length);
  assert.throws(()=>archiveCompletedCollectionRuns(store,new Date('invalid')),/cutoff/);
});

test('a deletion failure rolls back archive creation and all task/item changes',t=>{
  const store=new Store(':memory:',DEFAULT_CITIES);t.after(()=>store.close());
  const run=store.createRun('kopis','andong','2026-10-01','2026-10-31');
  store.upsert(item('TEST_ROLLBACK'),run);complete(store,run);
  const before=store.runs();
  store.db.exec("CREATE TRIGGER stop_task_delete BEFORE DELETE ON sync_tasks BEGIN SELECT RAISE(ABORT,'TEST rollback'); END;");
  assert.throws(()=>archiveCompletedCollectionRuns(store,cutoff),/TEST rollback/);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM sync_run_archive').get()!.n,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM sync_items').get()!.n,1);
  assert.deepEqual(store.runs(),before);
});
