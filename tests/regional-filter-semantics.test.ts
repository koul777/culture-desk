import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { DEFAULT_CITIES, NATIONAL_CITIES } from '../server/providers/cities.js';
import type { Bootstrap, MapResult, PerformanceInput, SearchResult } from '../shared/types.js';
import { queryString } from '../web/api.js';
import { defaultFilters, filterProblem, loadFilters, saveFilters, toSearchFilters } from '../web/lib/filters.js';

// Isolated TEST rows only; real API keys, provider requests and user databases are never used.
const range={from:'2026-10-01',to:'2026-10-31'};
const originalIds=new Set(DEFAULT_CITIES.map(city=>city.id));
const addedRegions=NATIONAL_CITIES.filter(city=>!originalIds.has(city.id));
const selected=['andong',addedRegions[0].id];
const others=['gongju',addedRegions.at(-1)!.id];
const performance=(id:number,cityId:string,changes:Partial<PerformanceInput>={}):PerformanceInput=>({
  source:'kopis',sourceId:`TEST_REGION_SCOPE_${id}`,title:`TEST 지역 공연 ${id}`,cityId,
  startDate:range.from,endDate:range.to,genre:'음악',sourceGenre:'TEST 음악',venue:'TEST 공연장',
  address:'',poster:'',sourceUrl:'',price:'',priceType:'unknown',age:'',runtime:'',cast:'',producer:'',organizer:'',
  contact:'',schedule:'',description:'',status:'',detailState:'complete',classification:'performance',reviewReason:'',raw:null,
  ...changes,
});

async function fixture(t:TestContext){
  const store=new Store(':memory:',NATIONAL_CITIES);
  const {app}=await createApp({port:4317,databasePath:':memory:',keys:{kopis:'',culture:''},requestIntervalMs:350,syncIntervalHours:24},
    {store,startWorker:false,serveStatic:false,searchOnly:true,providers:{}});
  t.after(async()=>{await app.close();store.close();});
  const allIds=[...selected,...others].map((cityId,index)=>store.upsert(performance(index,cityId)));
  allIds.push(store.upsert(performance(10,selected[1],{source:'culture'})));
  store.upsert(performance(11,selected[0],{classification:'excluded',genre:'기타'}));
  store.upsert(performance(12,selected[1],{classification:'review'}));
  store.upsert(performance(13,selected[0],{startDate:'2026-11-01',endDate:'2026-11-30'}));
  const note='TEST_PRIVATE_REGION_NOTE';store.bookmark(allIds[0],true,note);
  // Only the selected pair has complete source coverage for the requested month.
  for(const city of selected)for(const source of ['kopis','culture'] as const){
    const run=store.createRun(source,city,range.from,range.to);
    const task=store.nextTask()!;assert.equal(task.run_id,run);store.finishTask(task);
  }
  return{store,app,allIds,note};
}
function comparable(result:SearchResult|MapResult){
  return{ids:result.items.map(item=>item.id),total:result.total,sourceCounts:result.sourceCounts,pendingDetails:result.pendingDetails,partial:result.partial};
}

test('omitted, empty and all-region selection have identical public search and map scope',async t=>{
  const {app,allIds,note}=await fixture(t);
  const selections=[undefined,'',NATIONAL_CITIES.map(city=>city.id).join(',')];
  let reference:ReturnType<typeof comparable>|undefined;
  for(const route of ['/api/performances','/api/map'])for(const cities of selections){
    const params=new URLSearchParams({...range,limit:'100'});
    if(cities!==undefined)params.set('cities',cities);
    const response=await app.inject(`${route}?${params}`);assert.equal(response.statusCode,200);
    const result=response.json<SearchResult|MapResult>();
    if(reference)assert.deepEqual(comparable(result),reference);else reference=comparable(result);
    assert.deepEqual(new Set(result.items.map(item=>item.id)),new Set(allIds));
    assert.equal(result.total,5);assert.deepEqual(result.sourceCounts,{kopis:4,culture:1});
    assert.equal(result.partial,true,'Nationwide scope must not claim complete coverage from two collected regions');
    assert.ok(!response.body.includes(note));
    if(route==='/api/map')assert.ok(result.items.every(item=>!Object.hasOwn(item,'bookmarked')&&!Object.hasOwn(item,'note')));
    else assert.ok((result as SearchResult).items.every(item=>!item.bookmarked&&item.note===''));
  }
});

test('two checked regions restrict both endpoints while retaining their exact coverage and source counts',async t=>{
  const {app,allIds}=await fixture(t);
  const expected=new Set([allIds[0],allIds[1],allIds[4]]);
  for(const route of ['/api/performances','/api/map'])for(const ids of [selected,[...selected].reverse()]){
    const response=await app.inject(`${route}?${new URLSearchParams({...range,cities:ids.join(','),limit:'100'})}`);
    assert.equal(response.statusCode,200);const result=response.json<SearchResult>();
    assert.deepEqual(new Set(result.items.map(item=>item.id)),expected);
    assert.deepEqual(new Set(result.items.map(item=>item.cityId)),new Set(selected));
    assert.equal(result.total,3);assert.deepEqual(result.sourceCounts,{kopis:2,culture:1});assert.equal(result.partial,false);
  }
});

test('browser query serialization sends no city constraint for an empty selection and keeps explicit subsets',()=>{
  assert.equal(queryString({...range,cities:''}),queryString(range));
  assert.equal(new URLSearchParams(queryString({...range,cities:''})).has('cities'),false);
  assert.equal(new URLSearchParams(queryString({...range,cities:selected.join(',')})).get('cities'),selected.join(','));
});

const bootstrap:Bootstrap={cities:NATIONAL_CITIES,sources:[],bookmarkCount:0,pendingDetails:0,reviewCount:0,excludedCount:0,runs:[],today:'2026-10-16'};
function withLocalStorage<T>(saved:Record<string,string>,check:(values:Map<string,string>)=>T):T{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
  const values=new Map(Object.entries(saved));
  const localStorage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,String(value));}};
  Object.defineProperty(globalThis,'window',{value:{localStorage},configurable:true,writable:true});
  try{return check(values);}
  finally{
    if(previous)Object.defineProperty(globalThis,'window',previous);
    else Reflect.deleteProperty(globalThis,'window');
  }
}

test('fresh frontend filters have no preset seven-region selection and accept nationwide search',()=>{
  const defaults=defaultFilters(bootstrap);
  assert.deepEqual(defaults.cities,[]);
  assert.equal(filterProblem(defaults),null);
  assert.equal(new URLSearchParams(queryString(toSearchFilters(defaults))).has('cities'),false);
  withLocalStorage({},()=>assert.deepEqual(loadFilters(bootstrap).cities,[]));
});

test('legacy v1 saved seven-region defaults cannot reappear in the nationwide frontend',()=>{
  const legacy={...defaultFilters(bootstrap),cities:DEFAULT_CITIES.map(city=>city.id)};
  const before=Object.getOwnPropertyDescriptor(globalThis,'window');
  withLocalStorage({'culture-desk.filters.v1':JSON.stringify(legacy)},()=>{
    assert.deepEqual(loadFilters(bootstrap).cities,[]);
  });
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis,'window'),before,'test window must be restored');
});

test('v3 saves and restores an explicitly empty nationwide selection',()=>{
  withLocalStorage({},values=>{
    const filters={...defaultFilters(bootstrap),...range,cities:[],q:'TEST 전국 공연'};
    saveFilters(filters);
    assert.ok(values.has('culture-desk.filters.v3'));assert.equal(values.has('culture-desk.filters.v1'),false);
    assert.deepEqual(JSON.parse(values.get('culture-desk.filters.v3')!).cities,[]);
    const restored=loadFilters(bootstrap);
    assert.deepEqual(restored.cities,[]);assert.equal(restored.q,filters.q);assert.equal(restored.from,range.from);assert.equal(restored.to,range.to);
    assert.equal(filterProblem(restored),null);
    assert.equal(new URLSearchParams(queryString(toSearchFilters(restored))).has('cities'),false);
  });
});

test('v3 restores a chosen subset and keeps that subset in the outgoing search',()=>{
  withLocalStorage({},()=>{
    saveFilters({...defaultFilters(bootstrap),cities:[...selected]});
    const restored=loadFilters(bootstrap);
    assert.deepEqual(restored.cities,selected);
    assert.equal(new URLSearchParams(queryString(toSearchFilters(restored))).get('cities'),selected.join(','));
    assert.equal(filterProblem(restored),null);
  });
});

test('current nationwide period starts this month and old default period migrates without changing chosen cities',()=>{
  const defaults=defaultFilters(bootstrap);
  assert.equal(defaults.from,'2026-10-01');assert.equal(defaults.to,'2027-01-16');
  withLocalStorage({'culture-desk.filters.v2':JSON.stringify({...defaults,from:'2025-10-16',cities:selected})},()=>{
    const restored=loadFilters(bootstrap);
    assert.equal(restored.from,'2026-10-01');assert.deepEqual(restored.cities,selected);
  });
  withLocalStorage({'culture-desk.filters.v2':JSON.stringify({...defaults,from:'2025-05-01',to:'2025-06-01'})},()=>{
    const restored=loadFilters(bootstrap);
    assert.equal(restored.from,'2025-05-01');assert.equal(restored.to,'2025-06-01');
  });
});

test('empty-region validation permits nationwide scope without weakening date validation',()=>{
  const defaults=defaultFilters(bootstrap);
  assert.equal(filterProblem({...defaults,cities:[]}),null);
  assert.notEqual(filterProblem({...defaults,cities:[],from:''}),null);
  assert.notEqual(filterProblem({...defaults,cities:[],from:'2026-02-30'}),null);
  assert.notEqual(filterProblem({...defaults,cities:[],from:'2026-11-01',to:'2026-10-01'}),null);
});
