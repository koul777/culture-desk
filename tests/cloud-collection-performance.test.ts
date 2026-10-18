import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.js';
import { DEFAULT_CITIES } from '../server/providers/cities.js';
import { runCloudCollection, createCloudCollectionProviders } from '../server/cloud/collection.js';
import { SnapshotRepository } from '../server/cloud/snapshot.js';
import type { PerformanceInput, Provider, Source } from '../shared/types.js';
import { PglitePool } from './helpers/pglite-pool.js';
import { durableState } from './helpers/cloud-storage.js';

const env={AUTOMATIC_REFRESH_ENABLED:'1'};
const item=(id:string,source:Source='kopis'):PerformanceInput=>({source,sourceId:id,title:`TEST ${id}`,cityId:'andong',
  startDate:'2026-10-01',endDate:'2026-10-31',genre:'음악',sourceGenre:'music',venue:'TEST',address:'',poster:'',sourceUrl:'',
  price:'',priceType:'unknown',age:'',runtime:'',cast:'',producer:'',organizer:'',contact:'',schedule:'',description:'',status:'',
  detailState:'pending',classification:'performance',reviewReason:'',raw:{test:true}});
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};};
const provider=(source:Source,detail:Provider['detail']):Provider=>({source,list:async()=>({items:[],hasMore:false}),detail});
function seed(store:Store,count=1,source:Source='kopis') {
  const run=store.createRun(source,'andong','2026-10-01','2026-10-31',true);
  for(let n=0;n<count;n++){const value=item(`TEST_${source}_${n}`,source);store.upsert(value,run);store.addTask(run,source,'andong','detail',value.startDate,value.endDate,1,value.sourceId);}
  return run;
}
function memory(store:Store) {
  let writes=0;let active=0;
  return {get writes(){return writes;},get active(){return active;},withStore:async<T>(write:boolean,operation:(store:Store)=>Promise<T>,options:{skipUnchanged?:boolean}={})=>{
    active++;const before=store.db.prepare('SELECT total_changes() n').get()!.n;
    try {const result=await operation(store);if(write&&(!options.skipUnchanged||store.db.prepare('SELECT total_changes() n').get()!.n!==before))writes++;return result;}
    finally{active--;}
  }};
}
function expireClaims(store:Store) {
  store.db.exec("UPDATE cloud_collection_lease SET expires_at=0,next_request_at=0; UPDATE cloud_task_claims SET expires_at=0; UPDATE sync_tasks SET available_at='2000-01-01T00:00:00.000Z' WHERE state='queued'");
}

test('eight details use two durable batches writes, preserve raw/coordinates/notes, and idle ticks do not write',async()=>{
  const store=new Store(':memory:',DEFAULT_CITIES);try {
    seed(store,4,'kopis');seed(store,4,'culture');store.bookmark(1,true,'TEST retained note');
    const repository=memory(store);const starts:Record<Source,number[]>={kopis:[],culture:[]};
    const make=(source:Source)=>provider(source,async value=>{
      assert.equal(repository.active,0,'network I/O must run outside the snapshot transaction');starts[source].push(Date.now());
      await delay(25);return {...value,detailState:'complete',price:'TEST updated price',latitude:36.56,longitude:128.72,locationPrecision:'venue',raw:{detail:true,facility:{latitude:36.56}}};
    });
    const result=await runCloudCollection({env,repository,providers:{kopis:make('kopis'),culture:make('culture')}});
    assert.equal(result.steps,8);assert.equal(result.batches,1);assert.equal(result.active,false);assert.equal(repository.writes,2);
    for(const times of Object.values(starts))for(let n=1;n<times.length;n++)assert.ok(times[n]-times[n-1]>=345,'350ms source spacing is retained');
    assert.equal(store.runs().every(run=>run.state==='complete'),true);
    for(const value of store.search({},true).items){assert.equal(value.detailState,'complete');assert.equal(value.price,'TEST updated price');assert.equal(value.latitude,36.56);assert.equal(value.longitude,128.72);assert.deepEqual(store.internal(value.source,value.sourceId)!.raw,{detail:true,facility:{latitude:36.56}});}
    assert.equal(store.item(1)!.note,'TEST retained note');assert.equal(store.item(1)!.bookmarked,true);
    await runCloudCollection({env,repository,providers:{}});assert.equal(repository.writes,2);
  }finally{store.close();}
});

test('overlapping cloud ticks cannot fetch the same claim and do not hold a write transaction during I/O',async()=>{
  const store=new Store(':memory:',DEFAULT_CITIES);try {
    seed(store);const repository=memory(store),started=deferred<void>(),finish=deferred<void>();let calls=0;
    const providers={kopis:provider('kopis',async value=>{calls++;started.resolve();await finish.promise;return {...value,detailState:'complete'};})};
    const first=runCloudCollection({env,repository,providers});await started.promise;
    assert.equal(repository.active,0);const second=await runCloudCollection({env,repository,providers});
    assert.equal(second.steps,0);assert.equal(repository.writes,1);finish.resolve();await first;
    assert.equal(calls,1);assert.equal(repository.writes,2);assert.equal(store.runs()[0].state,'complete');
  }finally{store.close();}
});

test('pause preserves state and pending attempts; resume invalidates a pre-pause response and fetches current details',async()=>{
  const store=new Store(':memory:',DEFAULT_CITIES);try {
    const run=seed(store),repository=memory(store),started=deferred<void>(),finish=deferred<void>();
    const first=runCloudCollection({env,repository,providers:{kopis:provider('kopis',async value=>{started.resolve();await finish.promise;return {...value,title:'TEST stale paused',detailState:'complete'};})}});
    await started.promise;store.setRunState(run,'paused');finish.resolve();await first;
    assert.equal(store.runs()[0].state,'paused');assert.equal(store.db.prepare('SELECT attempts FROM sync_tasks').get()!.attempts,0);
    assert.equal(store.internal('kopis','TEST_kopis_0')!.detailState,'pending');
    store.setRunState(run,'queued');
    const startedAgain=deferred<void>(),finishAgain=deferred<void>();let calls=0;
    const next=runCloudCollection({env,repository,providers:{kopis:provider('kopis',async value=>{calls++;if(calls===1){startedAgain.resolve();await finishAgain.promise;return {...value,title:'TEST stale resumed',detailState:'complete'};}return {...value,title:'TEST fresh resumed',detailState:'complete'};})}});
    await startedAgain.promise;store.setRunState(run,'paused');store.setRunState(run,'queued');finishAgain.resolve();await next;
    assert.equal(calls,2);assert.equal(store.internal('kopis','TEST_kopis_0')!.title,'TEST fresh resumed');assert.equal(store.runs()[0].state,'complete');
    assert.equal(store.db.prepare('SELECT attempts FROM sync_tasks').get()!.attempts,1);
  }finally{store.close();}
});

test('expired claims recover and the old owner cannot overwrite a newer completed response',async()=>{
  const store=new Store(':memory:',DEFAULT_CITIES);try {
    seed(store);const repository=memory(store),started=deferred<void>(),finish=deferred<void>();
    const old=runCloudCollection({env,repository,providers:{kopis:provider('kopis',async value=>{started.resolve();await finish.promise;return {...value,title:'TEST obsolete',detailState:'complete'};})}});
    await started.promise;expireClaims(store);
    await runCloudCollection({env,repository,providers:{kopis:provider('kopis',async value=>({...value,title:'TEST newest',detailState:'complete'}))}});
    finish.resolve();await old;assert.equal(store.internal('kopis','TEST_kopis_0')!.title,'TEST newest');
    const task=store.db.prepare('SELECT state,attempts FROM sync_tasks').get()!;assert.equal(task.state,'done');assert.equal(task.attempts,1);
  }finally{store.close();}
});

test('concurrent record updates invalidate stale detail results and require another detail fetch without consuming an attempt',async()=>{
  const store=new Store(':memory:',DEFAULT_CITIES);try {
    seed(store);const repository=memory(store),started=deferred<void>(),finish=deferred<void>();
    const pending=runCloudCollection({env,repository,providers:{kopis:provider('kopis',async value=>{started.resolve();await finish.promise;return {...value,title:'TEST obsolete',detailState:'complete'};})}});
    await started.promise;store.upsert({...item('TEST_kopis_0'),title:'TEST imported newer',price:'TEST new price',detailState:'complete'});
    store.db.prepare('UPDATE performances SET updated_at=?').run(new Date(Date.now()+1000).toISOString());
    finish.resolve();await pending;assert.equal(store.internal('kopis','TEST_kopis_0')!.title,'TEST imported newer');
    const task=store.db.prepare('SELECT state,attempts FROM sync_tasks').get()!;assert.equal(task.state,'queued');assert.equal(task.attempts,0);assert.notEqual(store.runs()[0].state,'complete');
    expireClaims(store);let calls=0;
    await runCloudCollection({env,repository,providers:{kopis:provider('kopis',async value=>{calls++;assert.equal(value.price,'TEST new price');return {...value,title:'TEST freshly confirmed',detailState:'complete'};})}});
    assert.equal(calls,1);assert.equal(store.runs()[0].state,'complete');assert.equal(store.internal('kopis','TEST_kopis_0')!.title,'TEST freshly confirmed');
  }finally{store.close();}
});

for(const kind of ['quota','auth'])test(`${kind} stops not-yet-started source requests without spending their attempts`,async()=>{
  const store=new Store(':memory:',DEFAULT_CITIES);try {
    seed(store,4);const repository=memory(store);let calls=0;
    await runCloudCollection({env,repository,providers:{kopis:provider('kopis',async()=>{calls++;throw Object.assign(new Error('TEST provider failure'),{kind});})}});
    assert.equal(calls,1);assert.equal(store.runs()[0].state,kind==='quota'?'quota_wait':'partial');
    const tasks=store.db.prepare('SELECT state,attempts,available_at FROM sync_tasks ORDER BY id').all();
    assert.deepEqual(tasks.map(task=>task.attempts),[1,0,0,0]);assert.ok(tasks.every(task=>task.state==='queued'&&Date.parse(String(task.available_at))<=Date.now()));
    assert.equal(store.db.prepare('SELECT count(*) n FROM cloud_task_claims').get()!.n,0);
  }finally{store.close();}
});

test('each task receives its complete timeout after the 350ms source gate, and late success cannot bypass a timeout',async()=>{
  const store=new Store(':memory:',DEFAULT_CITIES);try {
    seed(store,4);const repository=memory(store);let calls=0;
    await runCloudCollection({env,repository,tickStepMs:30,tickBudgetMs:2000,providers:{kopis:provider('kopis',async value=>{
      calls++;await delay(10);return {...value,detailState:'complete'};
    })}});
    assert.equal(calls,4);assert.equal(store.runs()[0].state,'complete');
    seed(store,1,'culture');
    await runCloudCollection({env,repository,tickStepMs:10,tickBudgetMs:800,providers:{culture:provider('culture',async value=>{
      await delay(40);return {...value,detailState:'complete'}; // Deliberately ignores AbortSignal.
    })}});
    const task=store.db.prepare("SELECT state,attempts,error FROM sync_tasks WHERE source='culture'").get()!;
    assert.equal(task.state,'queued');assert.equal(task.attempts,1);assert.match(String(task.error),/응답 시간이 초과/);
    assert.equal(store.internal('culture','TEST_culture_0')!.detailState,'pending');
  }finally{store.close();}
});

test('request cancellation restores its unstarted/rejected claims without consuming attempts',async()=>{
  const store=new Store(':memory:',DEFAULT_CITIES);try {
    seed(store,4);const repository=memory(store),controller=new AbortController();let calls=0;
    const result=await runCloudCollection({env,repository,signal:controller.signal,providers:{kopis:provider('kopis',async(_value,signal)=>{
      calls++;controller.abort();signal!.throwIfAborted();throw new Error('unreachable');
    })}});
    assert.equal(calls,1);assert.equal(result.active,true);
    assert.equal(store.db.prepare('SELECT sum(attempts) n FROM sync_tasks').get()!.n,0);
    assert.equal(store.db.prepare('SELECT count(*) n FROM cloud_task_claims').get()!.n,0);
    assert.ok(store.db.prepare('SELECT available_at FROM sync_tasks').all().every(task=>Date.parse(String(task.available_at))<=Date.now()));
  }finally{store.close();}
});

test('a budget too short after claiming restores the claim and never starts provider I/O',async()=>{
  const store=new Store(':memory:',DEFAULT_CITIES);try {
    seed(store);const base=memory(store);let operations=0,calls=0;
    const repository={withStore:async<T>(write:boolean,operation:(store:Store)=>Promise<T>,options?:{skipUnchanged?:boolean})=>{
      const result=await base.withStore(write,operation,options);if(++operations===1)await delay(40);return result;
    }};
    const result=await runCloudCollection({env,repository,tickStepMs:40,tickBudgetMs:60,providers:{kopis:provider('kopis',async value=>{calls++;return value;})}});
    assert.equal(result.steps,0);assert.equal(calls,0);assert.equal(store.db.prepare('SELECT attempts FROM sync_tasks').get()!.attempts,0);
    assert.equal(store.db.prepare('SELECT count(*) n FROM cloud_task_claims').get()!.n,0);
    assert.equal(store.db.prepare('SELECT expires_at FROM cloud_collection_lease').get()!.expires_at,0);
    assert.ok(Date.parse(String(store.db.prepare('SELECT available_at FROM sync_tasks').get()!.available_at))<=Date.now());
  }finally{store.close();}
});

// A real PostgreSQL engine: the merge write fails on the statement that stores its changed rows.
const FAIL_PERSISTENCE=/INSERT INTO culture_desk_delta|UPDATE culture_desk_base/;
test('a failed merge preserves the durable claimed snapshot and can recover without lost records or spent attempts',async()=>{
  const pool=new PglitePool(),repository=new SnapshotRepository(pool);
  try {
    await repository.withStore(true,async store=>{seed(store);});
    const writes=pool.writes;let claimed:Awaited<ReturnType<typeof durableState>>|undefined;
    const failed=runCloudCollection({env,repository,providers:{kopis:provider('kopis',async value=>{
      // Provider I/O runs after the claim committed and before the merge write, which is made to fail.
      claimed=await durableState(pool);pool.failAlways=FAIL_PERSISTENCE;return {...value,title:'TEST uncommitted',detailState:'complete'};
    })}});
    await assert.rejects(failed,/persistence failure/);pool.failAlways=null;
    assert.ok(claimed,'the provider ran after the claim');
    assert.equal(pool.writes-writes,1,'only the claim was committed; the merge was not');
    assert.deepEqual(await durableState(pool),claimed,'the failed merge changed nothing durable');
    await repository.withStore(true,async store=>{
      assert.equal(store.internal('kopis','TEST_kopis_0')!.detailState,'pending');assert.equal(store.db.prepare('SELECT attempts FROM sync_tasks').get()!.attempts,0);expireClaims(store);
    });
    await runCloudCollection({env,repository,providers:{kopis:provider('kopis',async value=>({...value,title:'TEST recovered',detailState:'complete'}))}});
    for(const reader of [repository,new SnapshotRepository(pool)])await reader.withStore(false,async store=>{assert.equal(store.runs()[0].state,'complete');assert.equal(store.internal('kopis','TEST_kopis_0')!.title,'TEST recovered');assert.equal(store.db.prepare('SELECT attempts FROM sync_tasks').get()!.attempts,1);});
  } finally { await pool.close(); }
});

test('the actual HTTP gate counts facility requests and reuses facility responses without losing venue coordinates',async()=>{
  const starts:number[]=[];let facilityCalls=0;
  const providers=createCloudCollectionProviders({kopis:'TEST_NO_NETWORK'},async url=>{
    starts.push(Date.now());const parsed=new URL(url);const facility=parsed.pathname.includes('/prfplc/');
    if(facility){facilityCalls++;return new Response('<dbs><db><mt10id>FCTEST</mt10id><la>36.56</la><lo>128.72</lo><adres>TEST address</adres></db></dbs>');}
    const id=parsed.pathname.split('/').at(-1);return new Response(`<dbs><db><mt20id>${id}</mt20id><mt10id>FCTEST</mt10id><prfnm>TEST performance</prfnm><prfpdfrom>2026.10.01</prfpdfrom><prfpdto>2026.10.31</prfpdto><genrenm>서양음악(클래식)</genrenm><fcltynm>TEST venue</fcltynm></db></dbs>`);
  });
  const first=await providers.kopis!.detail(item('TEST_HTTP_1'));
  const second=await providers.kopis!.detail(item('TEST_HTTP_2'));
  assert.equal(starts.length,3);assert.equal(facilityCalls,1);
  for(let n=1;n<starts.length;n++)assert.ok(starts[n]-starts[n-1]>=345);
  for(const result of [first,second]){assert.equal(result.detailState,'complete');assert.equal(result.latitude,36.56);assert.equal(result.longitude,128.72);assert.equal(result.locationPrecision,'venue');}
});
