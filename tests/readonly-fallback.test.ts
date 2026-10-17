import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import ExcelJS from 'exceljs';
import { handleCloudRequest, MAX_API_RESPONSE_BYTES, type CloudOptions } from '../server/cloud/handler.js';
import { fileURLToPath } from 'node:url';
import { hydrateReadonlySnapshot, loadReadonlyFallback, readPublicSnapshot, DATABASE_RECHECK_MS, type PublicReadonlySnapshot } from '../server/cloud/readonly-fallback.js';
import { Store } from '../server/store.js';
import { DEFAULT_CITIES } from '../server/providers/cities.js';
import type { Performance } from '../shared/types.js';

const snapshotAt='2026-10-16T11:19:02.370Z';
const performance=(id=77,changes:Partial<Performance>={}):Performance=>({id,source:'kopis',sourceId:`TEST_PUBLIC_${id}`,title:'TEST 공개 공연',cityId:'andong',
  startDate:'2026-10-01',endDate:'2026-10-31',genre:'음악',sourceGenre:'music',venue:'TEST 공연장',address:'TEST 주소',poster:'',sourceUrl:'https://example.test/performance',
  price:'무료',priceType:'free',age:'전체',runtime:'60분',cast:'TEST 출연',producer:'',organizer:'',contact:'',schedule:'',description:'TEST 상세',status:'',
  latitude:36.56,longitude:128.72,locationPrecision:'venue',detailState:'complete',classification:'performance',reviewReason:'',updatedAt:'2026-10-16T10:00:00.000Z',note:'TEST_PRIVATE_NOTE',bookmarked:true,...changes});
const fixture=():PublicReadonlySnapshot=>({version:1,snapshotAt,performances:[performance(),performance(88,{source:'culture',cityId:'gangneung',latitude:undefined,longitude:undefined,locationPrecision:undefined})]});
const request=(route:string,method='GET',body?:unknown)=>new Request(`https://culture.test${route}`,{method,
  headers:body!==undefined?{'content-type':'application/json','x-culture-request':'1'}:{},...(body!==undefined?{body:JSON.stringify(body)}:{})});
function outage(snapshot=fixture()){
  let calls=0;const writes:boolean[]=[];
  const repository={withStore:async(write:boolean)=>{calls++;writes.push(write);throw Object.assign(new Error('TEST_PRIVATE_DATABASE_URL'),{code:'53000'});}};
  const options:CloudOptions={env:{AUTOMATIC_REFRESH_ENABLED:'1',KOPIS_API_KEY:'TEST_PRIVATE_KEY'},repository,readonlyFallback:{load:async()=>snapshot}};
  return {options,get calls(){return calls;},writes};
}

test('the fallback preserves public IDs/coordinates/timestamps and enforces SQLite read-only mode without personal/raw/queue data',()=>{
  const value=fixture();(value.performances[0] as any).raw={private:'TEST_PRIVATE_RAW'};
  const model=hydrateReadonlySnapshot(value);try{
    const item=model.store.item(77)!;assert.equal(item.id,77);assert.equal(item.updatedAt,value.performances[0].updatedAt);assert.equal(item.latitude,36.56);assert.equal(item.longitude,128.72);
    assert.equal(item.note,'');assert.equal(item.bookmarked,false);assert.equal(model.store.internal('kopis','TEST_PUBLIC_77')!.raw,null);
    for(const table of ['bookmarks','performance_sources','sync_runs','sync_tasks','sync_items'])assert.equal(model.store.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,0);
    assert.equal(model.store.db.prepare('PRAGMA query_only').get()!.query_only,1);
    assert.throws(()=>model.store.db.prepare('DELETE FROM performances').run(),/readonly|read-only/i);
    assert.ok(!JSON.stringify(model.store.search({},true)).includes('TEST_PRIVATE'));
  }finally{model.store.close();}
});

test('quota failures serve bootstrap/search/map/detail/building and HEAD from one public snapshot with truthful metadata',async()=>{
  const failed=outage();
  const bootResponse=await handleCloudRequest(request('/api/bootstrap'),failed.options);assert.equal(bootResponse.status,200);
  const boot=await bootResponse.json();assert.deepEqual(boot.fallback,{mode:'snapshot',snapshotAt,reason:'database_unavailable'});
  assert.equal(boot.runtime.backgroundSync,false);assert.equal(boot.automaticRefresh.status,'unavailable');assert.equal(boot.automaticRefresh.counts,null);assert.equal(boot.automaticRefresh.lastSuccessAt,null);
  assert.deepEqual(boot.runs,[]);assert.equal(boot.sources.every((source:any)=>source.lastSync===null),true);assert.equal(boot.bookmarkCount,0);
  for(const route of ['/api/performances','/api/map']){
    const response=await handleCloudRequest(request(route),failed.options);assert.equal(response.status,200);const body=await response.json();
    assert.equal(body.total,2);assert.equal(body.snapshotAt,snapshotAt);assert.equal(body.fallback.mode,'snapshot');assert.equal(body.partial,true);
    assert.ok(body.items.some((item:any)=>item.id===77&&item.latitude===36.56&&item.longitude===128.72));
    assert.ok(!JSON.stringify(body).includes('TEST_PRIVATE'));assert.equal(response.headers.get('x-culture-snapshot-at'),snapshotAt);
  }
  const detail=await handleCloudRequest(request('/api/performances/77'),failed.options);assert.equal(detail.status,200);assert.equal((await detail.json()).id,77);
  assert.equal((await handleCloudRequest(request('/api/performances/99999'),failed.options)).status,404);
  const building=await handleCloudRequest(request('/api/venues/building?performanceId=88'),failed.options);assert.equal(building.status,200);assert.equal((await building.json()).reason,'no_venue_coordinates');
  for(const route of ['/api/bootstrap','/api/performances','/api/map','/api/performances/77','/api/export.xlsx']){
    const head=await handleCloudRequest(request(route,'HEAD'),failed.options);assert.equal(head.status,200);assert.equal(await head.text(),'');
  }
  assert.equal(failed.calls,1,'the 45s circuit prevents repeated quota connections');assert.deepEqual(failed.writes,[false]);
});

test('fallback Excel contains selected public rows and explicitly records the saved snapshot date',async()=>{
  const failed=outage();const response=await handleCloudRequest(request('/api/export.xlsx?ids=77'),failed.options);
  assert.equal(response.status,200);assert.match(response.headers.get('content-disposition')!,/attachment/);
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()) as any);
  assert.equal(workbook.getWorksheet('공연 목록')!.rowCount,2);
  const contents=JSON.stringify(workbook.model);assert.match(contents,/임시 조회 자료/);assert.ok(contents.includes(snapshotAt));assert.ok(!contents.includes('TEST_PRIVATE_NOTE'));assert.ok(!contents.includes('TEST_PRIVATE_KEY'));
});

test('fallback never queues mutations, retains origin protection, and reports a 60s retry delay',async()=>{
  const failed=outage();await handleCloudRequest(request('/api/bootstrap'),failed.options);
  for(const route of ['/api/sync','/api/details','/api/cloud/tick','/api/sync/1/pause','/api/sync/1/resume','/api/performances/77/detail']){
    const response=await handleCloudRequest(request(route,'POST',{}),failed.options);assert.equal(response.status,503);assert.equal(response.headers.get('retry-after'),'60');
    const body=await response.json();assert.equal(body.code,'DATABASE_UNAVAILABLE');assert.equal(body.retryAfterSeconds,60);assert.equal(body.fallback.snapshotAt,snapshotAt);
  }
  assert.equal((await handleCloudRequest(request('/api/sync','POST'),failed.options)).status,403);
  assert.equal((await handleCloudRequest(request('/api/backup','POST',{}),failed.options)).status,404);
  assert.equal(failed.calls,1);assert.deepEqual(failed.writes,[false]);
});

test('after the circuit interval only one request probes, and successful database reads automatically end snapshot mode',async t=>{
  let now=1000,calls=0,recovered=false;let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
  const store=new Store(':memory:',DEFAULT_CITIES);t.after(()=>store.close());store.upsert({...performance(900),raw:null,title:'TEST LIVE'});
  const repository={withStore:async<T>(_write:boolean,operation:(store:Store)=>Promise<T>)=>{calls++;if(!recovered)throw Object.assign(new Error('TEST quota'),{code:'53000'});if(calls===2)await pending;return operation(store);}};
  const options:CloudOptions={env:{},repository,providers:{},readonlyFallback:{load:async()=>fixture(),now:()=>now}};
  assert.equal((await (await handleCloudRequest(request('/api/performances'),options)).json()).fallback.mode,'snapshot');
  now+=DATABASE_RECHECK_MS+1;recovered=true;
  const live=handleCloudRequest(request('/api/performances'),options);
  const overlap=await handleCloudRequest(request('/api/performances'),options);assert.equal((await overlap.json()).fallback.mode,'snapshot');assert.equal(calls,2);
  release();const restored=await live;const body=await restored.json();assert.equal(body.fallback,undefined);assert.equal(body.items[0].title,'TEST LIVE');assert.equal(restored.headers.has('x-culture-data-mode'),false);
  assert.equal((await (await handleCloudRequest(request('/api/bootstrap'),options)).json()).fallback,undefined);assert.equal(calls,3);
});

test('a missing or invalid public artifact retains the safe 503 response and never fabricates an empty successful search',async()=>{
  for(const load of [async()=>undefined,async()=>({version:999,snapshotAt,performances:[]} as unknown as PublicReadonlySnapshot)]){
    const failed=outage();failed.options.readonlyFallback={load};const response=await handleCloudRequest(request('/api/performances'),failed.options);
    assert.equal(response.status,503);assert.equal(response.headers.get('retry-after'),'60');const body=await response.json();assert.equal(body.fallback,undefined);assert.ok(!JSON.stringify(body).includes('TEST_PRIVATE'));
  }
});

test('fallback JSON and Excel preserve the 4MiB response cap, including empty HEAD error bodies',async()=>{
  const large=fixture();large.performances=[performance(77,{description:'한'.repeat(Math.ceil(MAX_API_RESPONSE_BYTES/3)+100)})];
  const failed=outage(large);
  for(const method of ['GET','HEAD']){const response=await handleCloudRequest(request('/api/performances',method),failed.options);assert.equal(response.status,413);if(method==='HEAD')assert.equal(await response.text(),'');else assert.equal((await response.json()).code,'RESPONSE_CAPACITY');}
  const excel=fixture();excel.performances=Array.from({length:200},(_,n)=>performance(n+1,{title:randomBytes(24000).toString('base64')}));
  const exportFailure=await handleCloudRequest(request('/api/export.xlsx'),outage(excel).options);assert.equal(exportFailure.status,413);assert.equal(exportFailure.headers.has('content-disposition'),false);
});

test('the bundled public artifact is usable and cached without inventing completed collection history',async()=>{
  const model=await loadReadonlyFallback();assert.ok(model);assert.equal(await loadReadonlyFallback(),model);
  assert.ok(model.store.counts().source.kopis>0);assert.ok(model.store.counts().source.culture>0);
  // Only the audited coverage recorded in the artifact becomes completed runs, nothing else.
  const artifact=await readPublicSnapshot(fileURLToPath(new URL('../server/assets/public-snapshot.json',import.meta.url)));
  const runs=model.store.runs();assert.equal(runs.length,artifact.coverage?.pairs.length??0);
  assert.ok(runs.every(run=>run.state==='complete'&&run.from===artifact.coverage!.from&&run.to===artifact.coverage!.to&&artifact.coverage!.pairs.includes(`${run.source}:${run.cityId}`)));
  assert.equal(model.store.db.prepare('PRAGMA query_only').get()!.query_only,1);assert.equal(model.metadata.reason,'database_unavailable');
});
