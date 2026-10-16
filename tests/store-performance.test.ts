import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Store } from '../server/store.js';
import { DEFAULT_CITIES } from '../server/providers/cities.js';
import type { SearchFilters, Source, SyncState } from '../shared/types.js';

const time = '2026-10-01T00:00:00.000Z';
function fixture(t: TestContext) {
  const store = new Store(':memory:', DEFAULT_CITIES);
  t.after(() => store.close());
  return store;
}
function run(store: Store, options: { city?: string; source?: Source; state?: SyncState; from?: string; to?: string; detailOnly?: boolean } = {}) {
  return Number(store.db.prepare(`INSERT INTO sync_runs(source,city_id,from_date,to_date,state,created_at,updated_at,error,detail_only)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(options.source || 'kopis', options.city || 'andong', options.from || '2026-10-01',
    options.to || '2026-10-31', options.state || 'complete', time, time, 'TEST audit message', options.detailOnly ? 1 : 0).lastInsertRowid);
}
function task(store: Store, id: number, state: string, key: string) {
  store.db.prepare(`INSERT INTO sync_tasks(run_id,kind,task_key,source,city_id,from_date,to_date,available_at,state)
    VALUES(?,'list',?,'kopis','andong','2026-10-01','2026-10-31',?,?)`).run(id,key,time,state);
}
function item(store: Store, id: number, classification: string) {
  const result = store.db.prepare(`INSERT INTO performances(source,source_id,city_id,start_date,end_date,classification,detail_state,data,updated_at)
    VALUES('kopis',?,'andong','2026-10-01','2026-10-31',?,'complete','{}',?)`).run(`TEST-${id}-${classification}`,classification,time);
  store.db.prepare('INSERT INTO sync_items VALUES(?,?)').run(id,result.lastInsertRowid);
}
function archive(store: Store, id: number) {
  store.db.prepare('INSERT INTO sync_run_archive VALUES(?,90,80,10,70,60,50,?,?)').run(id,'[]',time);
}
const totals = (value: ReturnType<Store['runs']>[number]) => [value.tasksTotal,value.tasksDone,value.tasksFailed,value.items,value.excluded,value.review];

test('run totals preserve independent live/archive fallback, zero counts and unrecognized states/classifications', t => {
  const store = fixture(t);
  const empty = run(store,{ state:'paused' });
  const live = run(store,{ state:'partial',detailOnly:true }); archive(store,live);
  task(store,live,'done','1'); task(store,live,'done','2'); task(store,live,'failed','3'); task(store,live,'queued','4');
  item(store,live,'review');
  const archived = run(store); archive(store,archived);
  const liveItems = run(store); archive(store,liveItems); item(store,liveItems,'performance');
  const liveTasks = run(store); archive(store,liveTasks); task(store,liveTasks,'unknown','1');
  const unknownItems = run(store); archive(store,unknownItems); item(store,unknownItems,'unknown');
  const result = store.runs();
  assert.deepEqual(result.map(value => value.id),[unknownItems,liveTasks,liveItems,archived,live,empty]);
  const byId = new Map(result.map(value => [value.id,value]));
  assert.deepEqual(totals(byId.get(empty)!),[0,0,0,0,0,0]);
  assert.deepEqual(totals(byId.get(live)!),[4,2,1,0,0,1]);
  assert.deepEqual(totals(byId.get(archived)!),[90,80,10,70,60,50]);
  assert.deepEqual(totals(byId.get(liveItems)!),[90,80,10,1,0,0]);
  assert.deepEqual(totals(byId.get(liveTasks)!),[1,0,0,70,60,50]);
  assert.deepEqual(totals(byId.get(unknownItems)!),[90,80,10,0,0,0]);
  assert.equal(byId.get(live)!.detailOnly,true);
  assert.equal(byId.get(live)!.state,'partial');
  assert.equal(byId.get(empty)!.state,'paused');
  assert.equal(byId.get(live)!.error,'TEST audit message');
  assert.equal(byId.get(live)!.createdAt,time);
  assert.equal(byId.get(live)!.updatedAt,time);
  assert.deepEqual(store.runs(1),result.slice(0,1));
  assert.deepEqual(store.runs(0),[]);
  assert.deepEqual(store.runs(-1),result);
  assert.deepEqual(store.runs(1,[empty,live,live,999999]),[byId.get(live),byId.get(empty)]);
  assert.deepEqual(store.runs(200,[]),[]);
});

test('large run histories use a constant number of read statements and retain the default limit', t => {
  const store = fixture(t);
  store.transaction(() => {
    for (let i=0;i<520;i++) {
      const id=run(store,{ source:i%2?'culture':'kopis' });
      if(i%2) archive(store,id); else { task(store,id,'done','1'); item(store,id,'performance'); }
    }
  });
  const prepare=store.db.prepare.bind(store.db);
  let reads=0;
  t.mock.method(store.db,'prepare',(sql: string) => { reads++; return prepare(sql); });
  assert.equal(store.runs(10000).length,520);
  assert.equal(reads,1,'run aggregate reads must not grow with run count');
  reads=0;
  assert.equal(store.runs().length,200);
  assert.equal(reads,1);
  reads=0;
  assert.equal(store.runs(1,Array.from({length:520},(_,i)=>i+1)).length,520);
  assert.equal(reads,1);
});

// The pre-optimization per-region predicate is the reference for coverage precedence.
function legacyPartial(store: Store, filters: SearchFilters) {
  const cities=filters.cities?.split(',').filter(Boolean) || [];
  const selected=cities.length?cities:store.cities().map(city=>city.id);
  const sources=filters.source?[filters.source]:['kopis','culture'];
  return selected.some(city=>sources.some(source=>{
    const complete=store.db.prepare(`SELECT id FROM sync_runs WHERE detail_only=0 AND city_id=? AND source=? AND state='complete'
      AND from_date<=? AND to_date>=? ORDER BY id DESC LIMIT 1`).get(city,source,filters.from!,filters.to!);
    if(!complete) return true;
    return !!store.db.prepare(`SELECT id FROM sync_runs WHERE detail_only=0 AND city_id=? AND source=? AND state!='complete'
      AND id>? AND from_date<=? AND to_date>=? LIMIT 1`).get(city,source,complete.id,filters.to!,filters.from!);
  }));
}

test('coverage respects region/source, full coverage, newer overlap, details-only and later recovery', t => {
  const store=fixture(t);
  const query:SearchFilters={cities:'andong',source:'kopis',from:'2026-10-10',to:'2026-10-20'};
  run(store,{state:'partial'});
  run(store);
  assert.equal(store.search(query).partial,false,'older failure is superseded by a complete covering run');
  run(store,{state:'quota_wait',from:'2026-10-20',to:'2026-10-21'});
  assert.equal(store.search(query).partial,true,'an unfinished inclusive boundary overlap invalidates older coverage');
  run(store,{from:'2026-10-15',to:'2026-10-20'});
  assert.equal(store.search(query).partial,true,'a newer complete subset does not cover the whole requested period');
  run(store);
  run(store,{state:'paused',detailOnly:true});
  run(store,{state:'queued',from:'2026-11-01',to:'2026-11-30'});
  assert.equal(store.search(query).partial,false,'later complete coverage supersedes the failure; detail and nonoverlapping runs are ignored');
  assert.equal(store.search({...query,source:'culture'}).partial,true);
  assert.equal(store.search({...query,cities:'yeosu'}).partial,true);
  assert.equal(store.search({...query,cities:'andong,unknown'}).partial,true);
  assert.equal(store.search({...query,cities:undefined}).partial,true);
});

test('batched coverage matches historical predicates across mixed run histories and selection filters', t => {
  const store=fixture(t);
  const cities=store.cities().map(city=>city.id);
  const states:SyncState[]=['complete','queued','running','partial','paused','quota_wait'];
  store.transaction(()=>{
    for(const city of cities) for(const source of ['kopis','culture'] as const) run(store,{city,source,from:'2026-09-01',to:'2026-12-31'});
    for(let i=0;i<120;i++) run(store,{city:cities[i%cities.length],source:i%2?'culture':'kopis',state:states[i%states.length],
      from:`2026-${i%3===0?'09':'10'}-${i%2?'01':'15'}`,to:`2026-${i%3===0?'09':'10'}-28`,detailOnly:i%5===0});
  });
  for(const selection of [undefined,'andong','yeosu,suncheon','andong,andong','unknown']) {
    for(const source of [undefined,'kopis','culture'] as const) {
      for(const [from,to] of [['2026-09-01','2026-09-30'],['2026-10-10','2026-10-20'],['2026-11-01','2026-11-30']]) {
        const filters={cities:selection,source,from,to};
        assert.equal(store.search(filters).partial,legacyPartial(store,filters),JSON.stringify(filters));
      }
    }
  }
  const prepare=store.db.prepare.bind(store.db);
  let coverageReads=0;
  t.mock.method(store.db,'prepare',(sql:string)=>{if(sql.includes('FROM sync_runs')) coverageReads++;return prepare(sql);});
  store.search({from:'2026-11-01',to:'2026-11-30'});
  assert.equal(coverageReads,1,'coverage SQL count must not grow with region count');
});
