/** Offline only: never opens a PostgreSQL connection or calls an original provider API. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SnapshotRepository, encodeSnapshot, type SnapshotPool, type SnapshotClient } from '../server/cloud/snapshot.js';
import { runCloudCollection } from '../server/cloud/collection.js';
import { Worker } from '../server/worker.js';
import type { PerformanceInput, Provider, Source } from '../shared/types.js';

class OfflinePool implements SnapshotPool {
  writes=0;private pending=Promise.resolve();
  constructor(public bytes:Buffer){}
  async connect():Promise<SnapshotClient> {
    let unlock:(()=>void)|undefined,staged:Buffer|undefined;const owner=this;
    return {query:async(sql,values=[])=>{
      if(sql.includes('FOR UPDATE')){const previous=owner.pending;owner.pending=new Promise<void>(resolve=>{unlock=resolve;});await previous;}
      if(sql.startsWith('SELECT data'))return {rows:[{data:owner.bytes}]};
      if(sql.startsWith('UPDATE culture_desk_snapshot'))staged=Buffer.from(values[0]);
      if(sql==='COMMIT'){if(staged){owner.bytes=staged;owner.writes++;}unlock?.();unlock=undefined;}
      if(sql==='ROLLBACK'){unlock?.();unlock=undefined;}return {rows:[]};
    },release(){assert.equal(unlock,undefined);}};
  }
}
const filename=path.resolve(process.argv[2]||'data/performance-baseline/production-before.db');
const output=path.resolve(process.argv[3]||'docs/verification/cloud-collection-performance.json');
const bytes=await readFile(filename),pool=new OfflinePool(encodeSnapshot(bytes)),repository=new SnapshotRepository(pool);
const runIds:number[]=[];
await repository.withStore(true,async store=>{
  assert.equal(Object.values(store.db.prepare('PRAGMA quick_check').get()!)[0],'ok');
  // Only the private in-memory copy changes; previous tasks and every performance are retained.
  store.db.exec("UPDATE sync_runs SET state='paused' WHERE state IN ('queued','running')");
  for(const source of ['kopis','culture'] as Source[]){
    const rows=store.db.prepare("SELECT data FROM performances WHERE source=? AND classification='performance' ORDER BY id LIMIT 20").all(source);
    assert.equal(rows.length,20);
    const first=JSON.parse(String(rows[0].data)) as PerformanceInput;
    const id=store.createRun(source,first.cityId,'2026-10-01','2027-01-16',true);runIds.push(id);
    for(const row of rows){const item=JSON.parse(String(row.data)) as PerformanceInput;store.addTask(id,source,item.cityId,'detail',item.startDate,item.endDate,1,item.sourceId);}
  }
});
const seed=Buffer.from(pool.bytes);
async function measure(mode:'legacy'|'batched') {
  const db=new OfflinePool(Buffer.from(seed)),repo=new SnapshotRepository(db);
  const starts:Record<Source,number[]>={kopis:[],culture:[]};let calls=0,ticks=0;
  const make=(source:Source):Provider=>({source,list:async()=>{throw new Error('Unexpected list request in detail benchmark');},detail:async value=>{
    calls++;starts[source].push(performance.now());await delay(25);return {...value,detailState:'complete'};
  }});
  const providers={kopis:make('kopis'),culture:make('culture')};
  const start=performance.now();
  if(mode==='legacy') {
    for(let task=0;task<40;task++){
      await repo.withStore(true,async store=>{
        const worker=new Worker(store,{port:4317,databasePath:store.filename,keys:{kopis:'TEST',culture:'TEST'},requestIntervalMs:350,syncIntervalHours:1000000},providers);
        await worker.tick();
      });
      ticks++;if(task<39)await delay(350); // Previous cloud path: sequential task, commit, interval.
    }
  }else{
    for(let tick=0;tick<10;tick++){
      const result=await runCloudCollection({env:{AUTOMATIC_REFRESH_ENABLED:'1'},repository:repo,providers});ticks++;
      if(!result.active)break;
    }
  }
  const durationMs=Math.round(performance.now()-start);
  let state!:{performanceRecords:number;dataAndRawSha256:string;completedTasks:number};
  await repo.withStore(false,async store=>{
    const runs=store.runs(200,runIds);assert.equal(runs.length,2);assert.ok(runs.every(run=>run.state==='complete'&&run.tasksDone===20));
    const records=store.db.prepare('SELECT p.source,p.source_id,p.data,s.raw FROM performances p LEFT JOIN performance_sources s ON s.performance_id=p.id ORDER BY p.source,p.source_id').all();
    state={performanceRecords:records.length,dataAndRawSha256:createHash('sha256').update(JSON.stringify(records)).digest('hex'),completedTasks:runs.reduce((sum,run)=>sum+run.tasksDone,0)};
  });
  assert.equal(calls,40);
  const minSourceIntervalMs=Math.floor(Math.min(...Object.values(starts).flatMap(times=>times.slice(1).map((time,index)=>time-times[index]))));
  assert.ok(minSourceIntervalMs>=345);
  return {durationMs,snapshotWrites:db.writes,providerCalls:calls,ticks,minSourceIntervalMs,...state};
}
const legacy=await measure('legacy');console.log(JSON.stringify({stage:'legacy',durationMs:legacy.durationMs,snapshotWrites:legacy.snapshotWrites}));
const batched=await measure('batched');
assert.equal(legacy.dataAndRawSha256,batched.dataAndRawSha256);
const report={measuredAt:new Date().toISOString(),fixture:{file:path.relative(process.cwd(),filename).replaceAll('\\','/'),sqliteBytes:bytes.length,compressedSeedBytes:seed.length,tasks:40,sources:{kopis:20,culture:20}},
  methodology:'Offline production-copy SQLite snapshot hydration, VACUUM, gzip, and commit simulation. Identical complete detail responses with 25ms fake latency. No API or PostgreSQL network I/O. Legacy serial task+350ms delay; batched allows both sources and up to four concurrent tasks per source, each source still starts at least 350ms apart. Setup and final validation excluded from timing. Dates and personal metadata retained; whole-data/raw hash checked.',
  legacy,batched,speedup:Number((legacy.durationMs/batched.durationMs).toFixed(2)),snapshotWriteReductionPercent:Number(((1-batched.snapshotWrites/legacy.snapshotWrites)*100).toFixed(1)),identicalData:true,
  limitations:'One local measurement, not a production SLA. Actual provider latency, quotas, PostgreSQL network latency and venue cache hits affect live collection speed.'};
await mkdir(path.dirname(output),{recursive:true});await writeFile(output,`${JSON.stringify(report,null,2)}\n`);
console.log(JSON.stringify(report,null,2));
