import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { DEFAULT_CITIES } from '../server/providers/cities.js';
import { restoreDatabase } from '../server/maintenance.js';
import { acquireLock } from '../server/lock.js';
import { readConfig } from '../server/config.js';
import { Worker } from '../server/worker.js';
import { createApp } from '../server/app.js';
import { sourceState } from '../web/lib/runs.js';

function temp(t:any) {
  const parent=realpathSync(os.tmpdir());const dir=mkdtempSync(path.join(parent,'culture-ops-test-'));
  t.after(()=>{const real=realpathSync(dir);assert.equal(path.dirname(real),parent);assert.ok(path.basename(real).startsWith('culture-ops-test-'));rmSync(real,{recursive:true,force:true});});
  return dir;
}
const config=(db:string)=>({port:4317,databasePath:db,keys:{kopis:'',culture:''},requestIntervalMs:100,syncIntervalHours:24});

test('backup and restore preserve the snapshot, retain previous database and refuse a running target',t=>{
  const dir=temp(t);const target=path.join(dir,'app.db');const backup=path.join(dir,'backup.db');
  let store=new Store(target,DEFAULT_CITIES);
  store.addCity({...DEFAULT_CITIES[0],id:'test-backup-city',name:'TEST 백업 도시'});
  store.backup(backup);
  store.addCity({...DEFAULT_CITIES[1],id:'test-later-city',name:'TEST 이후 변경'});
  store.close();
  const unlock=acquireLock(target);
  assert.throws(()=>restoreDatabase(backup,target),/이미 실행 중/);unlock();
  const result=restoreDatabase(backup,target);assert.ok(result.previous&&existsSync(result.previous));
  store=new Store(target,DEFAULT_CITIES);
  assert.ok(store.cities().some(c=>c.id==='test-backup-city'));assert.ok(!store.cities().some(c=>c.id==='test-later-city'));store.close();
  const previous=new Store(result.previous!,DEFAULT_CITIES);assert.ok(previous.cities().some(c=>c.id==='test-later-city'));previous.close();
});

test('invalid restore input never overwrites existing data and releases its own lock',t=>{
  const dir=temp(t);const target=path.join(dir,'app.db');const invalid=path.join(dir,'invalid.db');
  const store=new Store(target,DEFAULT_CITIES);store.close();
  const before=readFileSync(target);writeFileSync(invalid,'TEST this is not a SQLite file');
  assert.throws(()=>restoreDatabase(invalid,target));assert.deepEqual(readFileSync(target),before);assert.equal(existsSync(target+'.lock'),false);
});

test('configuration file supports quoted keys, applies safe bounds and reloads without exposing keys',async t=>{
  const dir=temp(t);const file=path.join(dir,'test.env');
  writeFileSync(file,'KOPIS_API_KEY=" TEST_FAKE_QUOTED_KEY "\nCULTURE_API_KEY=\nPORT=4318\nREQUEST_INTERVAL_MS=1\nSYNC_INTERVAL_HOURS=0\n');
  const loaded=readConfig(file,{});assert.equal(loaded.keys.kopis,'TEST_FAKE_QUOTED_KEY');assert.equal(loaded.port,4318);assert.equal(loaded.requestIntervalMs,100);assert.equal(loaded.syncIntervalHours,1);
  const store=new Store(':memory:',DEFAULT_CITIES);
  const {app}=await createApp(config(':memory:'),{store,startWorker:false,configLoader:()=>loaded});
  try {
    const before=(await app.inject('/api/bootstrap')).json();assert.equal(before.sources[0].configured,false);
    const response=await app.inject({method:'POST',url:'/api/config/reload',headers:{'x-culture-request':'1','content-type':'application/json'},payload:{}});assert.equal(response.statusCode,200);
    const after=await app.inject('/api/bootstrap');assert.equal(after.json().sources[0].configured,true);assert.ok(!after.body.includes(loaded.keys.kopis));
  }finally{await app.close();store.close();}
});

test('scheduled refresh catches up once and preserves quota-wait and paused work',()=>{
  const store=new Store(':memory:',DEFAULT_CITIES);
  const fake={source:'kopis' as const,list:async()=>({items:[],hasMore:false}),detail:async(item:any)=>item};
  const worker=new Worker(store,config(':memory:'),{kopis:fake});
  try {
    const id=store.createRun('kopis','andong','2026-01-01','2026-01-31');const task=store.nextTask()!;store.finishTask(task);
    store.db.prepare('UPDATE sync_runs SET updated_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z',id);
    worker.refreshDue();assert.equal(store.runs().length,2);worker.refreshDue();assert.equal(store.runs().length,2);
    store.setRunState(store.runs()[0].id,'quota_wait');worker.refreshDue();assert.equal(store.runs().length,2);assert.equal(store.runs()[0].state,'quota_wait');
    store.setRunState(store.runs()[0].id,'paused');worker.refreshDue();assert.equal(store.runs().length,2);assert.equal(store.runs()[0].state,'paused');
  }finally{store.close();}
});

test('detail-only completion never proves collection completion or replaces its last sync timestamp',async()=>{
  const store=new Store(':memory:',DEFAULT_CITIES);
  const fake={source:'kopis' as const,list:async()=>({items:[],hasMore:false}),detail:async(item:any)=>item};
  const {app}=await createApp(config(':memory:'),{store,providers:{kopis:fake},startWorker:false});
  try {
    const detail=store.createRun('kopis','andong','2026-01-01','2026-01-31',true);
    store.recomputeRun(detail);
    let boot=(await app.inject('/api/bootstrap')).json();
    assert.equal(boot.sources[0].lastSync,null);assert.equal(sourceState(boot,'kopis').label,'미수집');
    const collection=store.createRun('kopis','andong','2026-01-01','2026-01-31');
    store.finishTask(store.nextTask()!);
    store.db.prepare('UPDATE sync_runs SET updated_at=? WHERE id=?').run('2026-01-31T00:00:00.000Z',collection);
    // More than the visible history limit: the collection timestamp must still survive.
    for(let i=0;i<201;i++){const id=store.createRun('kopis','andong','2026-02-01','2026-02-01',true);store.recomputeRun(id);}
    boot=(await app.inject('/api/bootstrap')).json();
    assert.equal(boot.sources[0].lastSync,'2026-01-31T00:00:00.000Z');assert.equal(sourceState(boot,'kopis').label,'완료');
    const failed=store.createRun('kopis','andong','2026-03-01','2026-03-10');store.setRunState(failed,'partial');
    const latest=store.createRun('kopis','andong','2026-03-01','2026-03-10',true);store.recomputeRun(latest);
    boot=(await app.inject('/api/bootstrap')).json();assert.equal(sourceState(boot,'kopis').label,'일부 실패');
  }finally{await app.close();store.close();}
});

test('legacy Yeosu and Suncheon seeds upgrade once, preserve custom data and requeue stale region coverage',t=>{
  const dir=temp(t);const db=path.join(dir,'region-upgrade.db');
  let store=new Store(db,DEFAULT_CITIES);
  const yeosu=store.cities().find(c=>c.id==='yeosu')!;
  const legacy={...yeosu,name:'여수 기획',sido:'전라남도',kopisSido:'46',kopisSigungu:'4613',aliases:['사용자 별칭']};
  store.db.prepare('UPDATE cities SET data=? WHERE id=?').run(JSON.stringify(legacy),'yeosu');
  store.addCity({...legacy,id:'custom-yeosu'});
  const id=store.createRun('kopis','yeosu','2026-10-01','2026-10-31');store.finishTask(store.nextTask()!);store.close();
  store=new Store(db,DEFAULT_CITIES);
  const upgraded=store.cities().find(c=>c.id==='yeosu')!;
  assert.equal(upgraded.kopisSigungu,'1213');assert.equal(upgraded.name,'여수 기획');assert.ok(upgraded.aliases.includes('사용자 별칭'));
  assert.equal(store.cities().find(c=>c.id==='custom-yeosu')!.kopisSigungu,'4613');
  assert.equal(store.runs().find(r=>r.id===id)!.state,'queued');assert.equal(store.lastCollectionSync('kopis'),null);
  store.finishTask(store.nextTask()!);store.close();
  store=new Store(db,DEFAULT_CITIES);assert.equal(store.runs().find(r=>r.id===id)!.state,'complete');store.close();
});
