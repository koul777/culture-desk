import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { DEFAULT_CITIES } from '../server/providers/cities.js';
import { importCollection } from '../server/import-collection.js';
import type { PerformanceInput } from '../shared/types.js';

const item = (sourceId: string, changes: Partial<PerformanceInput> = {}): PerformanceInput => ({
  source:'kopis',sourceId,title:'TEST 공연',cityId:'andong',startDate:'2026-10-01',endDate:'2026-10-31',
  genre:'음악',sourceGenre:'음악',venue:'TEST 공연장',address:'',poster:'',sourceUrl:'',price:'',priceType:'unknown',
  age:'',runtime:'',cast:'',producer:'',organizer:'',contact:'',schedule:'',description:'',status:'',
  detailState:'pending',classification:'performance',reviewReason:'',raw:{test:true},...changes,
});

test('national collection merge preserves live IDs, notes, existing detail and uncollected past records', t => {
  const source=new Store(':memory:',DEFAULT_CITIES), target=new Store(':memory:',DEFAULT_CITIES);
  t.after(()=>{source.close();target.close();});
  const oldId=target.upsert(item('TEST_SHARED',{detailState:'complete',price:'30,000원',priceType:'paid',latitude:36.5,longitude:128.7,locationPrecision:'venue'}));
  target.bookmark(oldId,true,'TEST_PRIVATE_NOTE');
  const pastId=target.upsert(item('TEST_PAST',{startDate:'2025-10-01',endDate:'2025-10-31'}));
  source.upsert(item('TEST_SHARED',{title:'TEST 최신 제목'}));
  source.upsert(item('TEST_NEW'));
  importCollection(source.db,target,'TEST_NATIONAL');
  assert.equal(target.internal('kopis','TEST_SHARED')?.price,'30,000원');
  assert.equal(target.item(oldId)?.title,'TEST 최신 제목');
  assert.equal(target.item(oldId)?.note,'TEST_PRIVATE_NOTE');
  assert.equal(target.item(oldId)?.latitude,36.5);
  assert.ok(target.item(pastId));
  assert.equal(target.counts().source.kopis,3);
});

test('only completed source coverage is published and repeat publication is idempotent',t=>{
  const source=new Store(':memory:',DEFAULT_CITIES),target=new Store(':memory:',DEFAULT_CITIES);
  t.after(()=>{source.close();target.close();});
  const run=source.createRun('kopis','andong','2026-10-01','2026-10-31');
  source.upsert(item('TEST_A'),run);
  const incomplete=importCollection(source.db,target,'TEST_NATIONAL');
  assert.equal(incomplete.addedRuns,0);
  assert.equal(target.runs().length,0);
  source.finishTask(source.nextTask()!);
  const complete=importCollection(source.db,target,'TEST_NATIONAL');
  assert.equal(complete.addedRuns,1);
  assert.equal(target.runs()[0].tasksDone,1);
  assert.equal(target.runs()[0].items,1);
  assert.equal(importCollection(source.db,target,'TEST_NATIONAL').addedRuns,0);
  assert.equal(target.runs().length,1);
  assert.equal(target.counts().source.kopis,1);
});

test('invalid collection identity cannot mutate the target',t=>{
  const source=new Store(':memory:',DEFAULT_CITIES),target=new Store(':memory:',DEFAULT_CITIES);
  t.after(()=>{source.close();target.close();});
  source.upsert(item('TEST_A'));
  assert.throws(()=>importCollection(source.db,target,'../invalid'));
  assert.equal(target.counts().source.kopis,0);
});

test('an old checkpoint or failed detail never overwrites newer complete live information',t=>{
  const source=new Store(':memory:',DEFAULT_CITIES),target=new Store(':memory:',DEFAULT_CITIES);
  t.after(()=>{source.close();target.close();});
  source.upsert(item('TEST_STALE',{detailState:'complete',price:'OLD',latitude:36.1,longitude:128.1}));
  const id=target.upsert(item('TEST_STALE',{detailState:'complete',price:'NEW',latitude:37.2,longitude:127.2}));
  source.db.prepare('UPDATE performances SET updated_at=?').run('2026-10-01T00:00:00.000Z');
  target.db.prepare('UPDATE performances SET updated_at=?').run('2026-10-16T00:00:00.000Z');
  assert.equal(importCollection(source.db,target,'TEST_VERSION').skippedNewerOrCompleteItems,1);
  assert.equal(target.item(id)?.price,'NEW');assert.equal(target.item(id)?.latitude,37.2);
  source.upsert(item('TEST_STALE',{detailState:'failed'}));
  source.db.prepare('UPDATE performances SET updated_at=?').run('2026-10-17T00:00:00.000Z');
  importCollection(source.db,target,'TEST_VERSION');
  assert.equal(target.item(id)?.detailState,'complete');assert.equal(target.item(id)?.price,'NEW');
});

test('publishing older complete runs cannot hide newer live or source collection gaps',t=>{
  const source=new Store(':memory:',DEFAULT_CITIES),target=new Store(':memory:',DEFAULT_CITIES);
  t.after(()=>{source.close();target.close();});
  source.createRun('kopis','andong','2026-10-01','2026-10-31');source.finishTask(source.nextTask()!);
  source.db.prepare('UPDATE sync_runs SET created_at=?,updated_at=?').run('2026-10-01T00:00:00.000Z','2026-10-01T01:00:00.000Z');
  target.createRun('kopis','andong','2026-10-01','2026-10-31');
  target.db.prepare('UPDATE sync_runs SET created_at=?,updated_at=?').run('2026-10-16T00:00:00.000Z','2026-10-16T00:00:00.000Z');
  assert.equal(importCollection(source.db,target,'TEST_COVERAGE').addedRuns,0);
  assert.equal(target.search({cities:'andong',source:'kopis',from:'2026-10-01',to:'2026-10-31'}).partial,true);
  const isolated=new Store(':memory:',DEFAULT_CITIES);t.after(()=>isolated.close());
  assert.equal(importCollection(source.db,isolated,'TEST_COVERAGE').addedRuns,1);
  source.createRun('kopis','andong','2026-10-01','2026-10-31');
  importCollection(source.db,isolated,'TEST_COVERAGE');
  assert.equal(isolated.search({cities:'andong',source:'kopis',from:'2026-10-01',to:'2026-10-31'}).partial,true);
  const legacy=new Store(':memory:',DEFAULT_CITIES);t.after(()=>legacy.close());
  legacy.createRun('kopis','andong','2026-10-01','2026-10-31');legacy.finishTask(legacy.nextTask()!);
  legacy.db.prepare('UPDATE sync_runs SET created_at=?,updated_at=?').run('2026-10-01T00:00:00.000Z','2026-10-01T01:00:00.000Z');
  importCollection(source.db,legacy,'TEST_COVERAGE');
  assert.equal(legacy.search({cities:'andong',source:'kopis',from:'2026-10-01',to:'2026-10-31'}).partial,true);
});

test('finished refresh restores temporarily hidden completion history without disguising real failures',t=>{
  const source=new Store(':memory:',DEFAULT_CITIES),target=new Store(':memory:',DEFAULT_CITIES);
  t.after(()=>{source.close();target.close();});
  const past=target.createRun('kopis','andong','2026-10-01','2026-10-31');target.finishTask(target.nextTask()!);
  target.db.prepare('UPDATE sync_runs SET created_at=?,updated_at=? WHERE id=?').run('2026-10-01T00:00:00.000Z','2026-10-01T01:00:00.000Z',past);
  const failed=target.createRun('kopis','andong','2026-10-01','2026-10-31');
  target.db.prepare("UPDATE sync_runs SET state='partial',error='TEST_REAL_FAILURE',created_at='2026-10-02T00:00:00.000Z',updated_at='2026-10-02T01:00:00.000Z' WHERE id=?").run(failed);
  source.createRun('kopis','andong','2026-10-01','2026-10-31');
  importCollection(source.db,target,'TEST_DAILY_REFRESH');
  assert.equal(target.runs().find(run=>run.id===past)?.state,'partial');
  source.finishTask(source.nextTask()!);
  importCollection(source.db,target,'TEST_DAILY_REFRESH');
  const restored=target.runs().find(run=>run.id===past)!;
  assert.equal(restored.state,'complete');assert.equal(restored.error,'');assert.equal(restored.tasksDone,1);
  assert.equal(restored.updatedAt,'2026-10-01T01:00:00.000Z');
  assert.equal(target.runs().find(run=>run.id===failed)?.error,'TEST_REAL_FAILURE');
  assert.equal(target.runs().find(run=>run.id===failed)?.state,'partial');
});
