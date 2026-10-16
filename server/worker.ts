import type { Provider, SearchFilters, Source, SyncRequest, PerformanceInput, City, ListResponse } from '../shared/types.js';
import { Store, type Task } from './store.js';
import type { Config } from './config.js';
import { createProviders } from './providers/index.js';

export interface CollectionInput { task: Task; city?: City; item?: PerformanceInput }
export type CollectionResult = {kind:'list';value:ListResponse}|{kind:'detail';value:PerformanceInput};
export function readCollectionInput(store:Store,task:Task):CollectionInput {
  if(task.kind==='list') {
    const city=store.cities().find(c=>c.id===task.city_id);if(!city)throw new Error('city');
    return {task,city};
  }
  const item=store.internal(task.source,task.source_id);if(!item)throw new Error('missing');
  return {task,item};
}
/** Provider I/O is separate from persistence so cloud work need not hold a database lock. */
export async function fetchCollectionTask(provider:Provider,input:CollectionInput,signal?:AbortSignal):Promise<CollectionResult> {
  const {task}=input;
  if(task.kind==='list') {
    const value=await provider.list({city:input.city!,from:task.from_date,to:task.to_date,page:task.page,pageSize:100},signal);
    if(value.hasMore&&task.page>=10000)throw Object.assign(new Error('pagination'),{kind:'schema'});
    return {kind:'list',value};
  }
  return {kind:'detail',value:await provider.detail(input.item!,signal)};
}
export interface CollectionMergeGuard { observedAt:string }
/** A cloud response may arrive after another writer has refreshed the same record. */
export function applyCollectionResult(store:Store,task:Task,result:CollectionResult,guard?:CollectionMergeGuard) {
  store.transaction(()=>{
    const persist=(item:PerformanceInput)=>{
      if(guard&&task.kind==='list') {
        const current=store.db.prepare('SELECT id,data,updated_at FROM performances WHERE source=? AND source_id=?').get(item.source,item.sourceId);
        const changed=current&&String(current.updated_at)>guard.observedAt;
        if(current&&changed) {
          store.db.prepare('INSERT OR IGNORE INTO sync_items VALUES(?,?)').run(task.run_id,current.id);
          return JSON.parse(String(current.data)) as PerformanceInput;
        }
      }
      store.upsert(item,task.run_id);return item;
    };
    if(result.kind==='list') {
      for(const item of result.value.items) {
        const saved=persist(item);
        // Existing complete details are refreshed too; exclusions alone skip detail calls.
        if(saved.classification!=='excluded')store.addTask(task.run_id,task.source,task.city_id,'detail',task.from_date,task.to_date,1,item.sourceId);
      }
      if(result.value.hasMore)store.addTask(task.run_id,task.source,task.city_id,'list',task.from_date,task.to_date,task.page+1,'');
    }else persist(result.value);
    store.finishTask(task);
  });
}
export function applyCollectionFailure(store:Store,task:Task,error:unknown,messageOverride?:string) {
  const kind=(error as {kind?:string})?.kind||'network';
  const message=messageOverride||(kind==='auth'?'인증키가 거절되었습니다. 키와 승인을 확인한 뒤 재개하세요.':kind==='quota'?'제공기관 호출 한도에 도달했습니다. 한도가 회복되면 재개하세요.':kind==='schema'?'제공기관 응답 형식을 확인할 수 없습니다. 해당 구간을 재시도하세요.':'제공기관 연결에 실패했습니다. 잠시 후 다시 시도합니다.');
  store.failTask(task,message,kind);
  if(task.kind==='detail'&&task.attempts>=3) {
    const item=store.internal(task.source,task.source_id);
    if(item&&item.detailState!=='complete')store.upsert({...item,detailState:'failed'});
  }
}

export class Worker {
  providers: Partial<Record<Source, Provider>>;
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private stopped = true;
  private abort = new AbortController();
  private lastScheduleCheck = 0;
  constructor(public store: Store, public config: Config, providers?: Partial<Record<Source, Provider>>) {
    this.providers = providers || createProviders(config.keys);
  }
  configure(config: Config) { this.config = config; this.providers = createProviders(config.keys); }
  start() { if (!this.stopped) return; this.stopped = false; this.abort = new AbortController(); this.schedule(50); }
  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.active = this.tick().catch(() => { /* Errors are recorded by task; no request URL/key is logged. */ }).finally(() => this.schedule(this.config.requestIntervalMs));
    },delay);
    this.timer.unref();
  }
  async stop() { this.stopped = true; clearTimeout(this.timer); this.abort.abort(); await this.active; }
  enqueue(request: SyncRequest) {
    const skipped = request.sources.filter(s=>!this.providers[s]); const ids:number[] = [];
    this.store.transaction(()=>{ for(const source of request.sources) if(this.providers[source]) for(const city of request.cities) ids.push(this.store.createRun(source,city,request.from,request.to)); });
    return { runs:this.store.runs(200,ids),skipped };
  }
  enqueueDetails(filters: SearchFilters): number {
    const base = { ...filters, price: undefined, age: undefined };
    const candidates = this.store.search(base,true).items.filter(p=>p.detailState!=='complete'&&this.providers[p.source]&&!this.store.hasPendingDetail(p.source,p.sourceId));
    const groups=new Map<string,typeof candidates>();
    for(const item of candidates){const key=`${item.source}:${item.cityId}`;const group=groups.get(key)||[];group.push(item);groups.set(key,group);}
    this.store.transaction(()=>{
      for(const items of groups.values()){
        const first=items[0];const from=items.map(p=>p.startDate).sort()[0];const to=items.map(p=>p.endDate).sort().at(-1)!;
        const id=this.store.createRun(first.source,first.cityId,from,to,true);
        for(const item of items)this.store.addTask(id,item.source,item.cityId,'detail',from,to,1,item.sourceId);
      }
    });
    return candidates.length;
  }
  enqueueDetail(source: Source, sourceId: string): number {
    if(!this.providers[source]) return 0;
    const item = this.store.internal(source,sourceId);
    if(!item || this.store.hasPendingDetail(source,sourceId)) return 0;
    const id=this.store.createRun(source,item.cityId,item.startDate,item.endDate,true);
    this.store.addTask(id,source,item.cityId,'detail',item.startDate,item.endDate,1,sourceId);
    return 1;
  }
  async tick() {
    if(Date.now()-this.lastScheduleCheck>60000) { this.lastScheduleCheck=Date.now(); this.refreshDue(); }
    const task=this.store.nextTask(); if(!task) return;
    const provider=this.providers[task.source];
    if(!provider) { this.store.failTask(task,'API 키를 입력한 뒤 설정을 다시 읽고 재개하세요.','auth'); return; }
    try {
      const result=await fetchCollectionTask(provider,readCollectionInput(this.store,task),this.abort.signal);
      applyCollectionResult(this.store,task,result);
    } catch(error) {
      if(this.abort.signal.aborted) { this.store.db.prepare("UPDATE sync_tasks SET state='queued',attempts=MAX(0,attempts-1) WHERE id=?").run(task.id); return; }
      applyCollectionFailure(this.store,task,error);
    }
  }
  refreshDue() {
    const seen=new Set<string>();
    for(const run of this.store.runs(10000)) {
      if ((this.store.db.prepare('SELECT detail_only FROM sync_runs WHERE id=?').get(run.id) as {detail_only:number}).detail_only) continue;
      const key=`${run.source}:${run.cityId}`;
      if(seen.has(key)) continue; seen.add(key);
      if(run.state!=='complete' || !this.providers[run.source] || Date.now()-Date.parse(run.updatedAt)<this.config.syncIntervalHours*3600000) continue;
      this.store.createRun(run.source,run.cityId,run.from,run.to);
    }
  }
}
