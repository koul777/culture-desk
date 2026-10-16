import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { Provider, Source } from '../../shared/types.js';
import type { Store, Task } from '../store.js';
import type { SnapshotRepository } from './snapshot.js';
import { createProviders } from '../providers/index.js';
import type { FetchFn } from '../providers/fetch.js';
import { Worker, readCollectionInput, fetchCollectionTask, applyCollectionResult, applyCollectionFailure, type CollectionInput, type CollectionResult } from '../worker.js';

export const CLOUD_COLLECTION_LEASE_MS=90000;
const INTERVAL_MS=350;
const SOURCES:Source[]=['kopis','culture'];
const SCHEMA=`CREATE TABLE IF NOT EXISTS cloud_collection_lease(
  id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,expires_at INTEGER NOT NULL,next_request_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS cloud_task_claims(
  task_id INTEGER PRIMARY KEY REFERENCES sync_tasks(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,expires_at INTEGER NOT NULL,available_before TEXT NOT NULL);`;
type Repository=Pick<SnapshotRepository,'withStore'>;
interface ClaimedTask {task:Task;input?:CollectionInput;inputError?:unknown;observedAt:string;itemVersion?:string;reservedUntil:string}
interface Batch {owner:string;tasks:ClaimedTask[];active:boolean;notBefore:number}
interface Outcome {claim:ClaimedTask;result?:CollectionResult;error?:unknown;timedOut?:boolean;cancelled?:boolean}
const requestContext=new AsyncLocalStorage<{started:boolean;onStart:()=>void}>();
class SourceBlockedError extends Error {}
export interface CloudCollectionOptions {
  env:NodeJS.ProcessEnv;repository:Repository;providers?:Partial<Record<Source,Provider>>;
  tickBudgetMs?:number;tickStepMs?:number;signal?:AbortSignal;
}
function active(store:Store):boolean {
  return !!store.db.prepare("SELECT 1 FROM sync_runs WHERE state IN ('queued','running') LIMIT 1").get();
}

/** One owner across serverless instances keeps HTTP throttles and claims from racing. */
async function claimBatch(options:CloudCollectionOptions,limit:number):Promise<Batch> {
  return options.repository.withStore(true,async store=>{
    store.db.exec(SCHEMA);
    const now=Date.now(),owner=randomUUID();
    const lease=store.db.prepare('SELECT * FROM cloud_collection_lease WHERE id=1').get();
    if(lease&&Number(lease.expires_at)>now)return {owner,tasks:[],active:active(store),notBefore:0};
    if(options.env.AUTOMATIC_REFRESH_ENABLED!=='1') {
      // Legacy installations still schedule their existing ranges. No provider calls occur here.
      new Worker(store,{port:4317,databasePath:store.filename,keys:{kopis:options.env.KOPIS_API_KEY||'',culture:options.env.CULTURE_API_KEY||''},requestIntervalMs:INTERVAL_MS,syncIntervalHours:24},options.providers).refreshDue();
    }
    const rows:Task[]=[];
    for(const source of SOURCES) {
      rows.push(...store.db.prepare(`SELECT t.* FROM sync_tasks t JOIN sync_runs r ON r.id=t.run_id
        LEFT JOIN cloud_task_claims c ON c.task_id=t.id
        WHERE t.source=? AND t.state='queued' AND t.available_at<=? AND r.state IN ('queued','running')
        AND (c.task_id IS NULL OR c.expires_at<=?)
        ORDER BY CASE t.kind WHEN 'list' THEN 0 ELSE 1 END,t.id LIMIT ?`)
        .all(source,new Date(now).toISOString(),now,Math.min(4,limit-rows.length)) as unknown as Task[]);
      if(rows.length>=limit)break;
    }
    if(!rows.length)return {owner,tasks:[],active:active(store),notBefore:0};
    const expires=now+CLOUD_COLLECTION_LEASE_MS,reservedUntil=new Date(expires).toISOString();
    const notBefore=Math.max(now,Number(lease?.next_request_at||0));
    const tasks:ClaimedTask[]=rows.map(task=>{
      const claim:ClaimedTask={task,observedAt:new Date(now).toISOString(),reservedUntil};
      try {claim.input=readCollectionInput(store,task);}catch(error){claim.inputError=error;}
      if(task.kind==='detail')claim.itemVersion=String(store.db.prepare('SELECT updated_at FROM performances WHERE source=? AND source_id=?').get(task.source,task.source_id)?.updated_at||'');
      return claim;
    });
    store.transaction(()=>{
      store.db.prepare(`INSERT INTO cloud_collection_lease VALUES(1,?,?,?) ON CONFLICT(id)
        DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at,next_request_at=excluded.next_request_at`).run(owner,expires,notBefore);
      for(const claim of tasks) {
        store.db.prepare(`INSERT INTO cloud_task_claims VALUES(?,?,?,?) ON CONFLICT(task_id)
          DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at,available_before=excluded.available_before`)
          .run(claim.task.id,owner,expires,claim.task.available_at);
        // queued is retained: Store startup recovery and old workers cannot steal an unexpired claim.
        store.db.prepare('UPDATE sync_tasks SET available_at=? WHERE id=?').run(reservedUntil,claim.task.id);
      }
    });
    return {owner,tasks,active:true,notBefore};
  },{skipUnchanged:true});
}

class SourceGate {
  private tail=Promise.resolve();private next=0;private active=0;
  constructor(private readonly blocked:()=>boolean=()=>false){}
  async run<T>(operation:()=>Promise<T>,signal?:AbortSignal):Promise<T> {
    const enter=this.tail.then(async()=>{
      while(this.active>=4||Date.now()<this.next){if(this.blocked())throw new SourceBlockedError();signal?.throwIfAborted();await delay(Math.min(50,Math.max(1,this.next-Date.now())),undefined,{signal});}
      if(this.blocked())throw new SourceBlockedError();signal?.throwIfAborted();this.active++;this.next=Date.now()+INTERVAL_MS;
    });
    this.tail=enter.catch(()=>{});await enter;
    try{const context=requestContext.getStore();if(context&&!context.started){context.started=true;context.onStart();}return await operation();}finally{this.active--;}
  }
}
/** The gate wraps actual HTTP, so a KOPIS facility lookup also consumes a 350ms slot. */
export function createCloudCollectionProviders(keys:Partial<Record<Source,string>>,fetchFn:FetchFn=fetch,blocked=new Set<Source>()):Partial<Record<Source,Provider>> {
  const gates={kopis:new SourceGate(()=>blocked.has('kopis')),culture:new SourceGate(()=>blocked.has('culture'))};
  return createProviders({kopis:keys.kopis||'',culture:keys.culture||''},{fetch:async(url,init)=>{
    const source=new URL(url).hostname.endsWith('kopis.or.kr')?'kopis':'culture';
    return gates[source].run(async()=>{
      const response=await fetchFn(url,init);const body=await response.arrayBuffer();
      return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
    },init?.signal||undefined);
  }});
}
function injectedProviders(providers:Partial<Record<Source,Provider>>,blocked:Set<Source>):Partial<Record<Source,Provider>> {
  // Test/custom providers have no HTTP transport hook; preserve the same per-source task spacing.
  return Object.fromEntries(Object.entries(providers).map(([source,provider])=>{
    const gate=new SourceGate(()=>blocked.has(source as Source));return [source,{source:provider.source,
      list:(input:Parameters<Provider['list']>[0],signal?:AbortSignal)=>gate.run(()=>provider.list(input,signal),signal),
      detail:(input:Parameters<Provider['detail']>[0],signal?:AbortSignal)=>gate.run(()=>provider.detail(input,signal),signal)}];
  }));
}
async function fetchBatch(batch:Batch,providers:Partial<Record<Source,Provider>>,stepMs:number,blocked:Set<Source>,signal?:AbortSignal):Promise<Outcome[]> {
  if(batch.notBefore>Date.now())await delay(batch.notBefore-Date.now(),undefined,{signal}).catch(()=>{});
  return Promise.all(batch.tasks.map(async claim=>{
    const controller=new AbortController();let timedOut=false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const context={started:false,onStart:()=>{timer=setTimeout(()=>{timedOut=true;controller.abort();},stepMs);}};
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    try {
      controller.signal.throwIfAborted();
      if(claim.inputError)throw claim.inputError;
      const provider=providers[claim.task.source];if(!provider)throw Object.assign(new Error('provider unavailable'),{kind:'auth'});
      const result=await requestContext.run(context,()=>fetchCollectionTask(provider,claim.input!,controller.signal));
      // A custom/slow transport may resolve after cancellation; that response cannot certify completion.
      controller.signal.throwIfAborted();
      return {claim,result};
    }catch(error){
      const kind=(error as {kind?:string})?.kind;if(kind==='auth'||kind==='quota')blocked.add(claim.task.source);
      return {claim,error,timedOut,cancelled:!!signal?.aborted||error instanceof SourceBlockedError||(blocked.has(claim.task.source)&&!context.started&&kind!=='auth'&&kind!=='quota')};
    }
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }));
}
async function mergeBatch(options:CloudCollectionOptions,batch:Batch,outcomes:Outcome[]):Promise<boolean> {
  return options.repository.withStore(true,async store=>{
    store.db.exec(SCHEMA);
    const lease=store.db.prepare('SELECT owner,expires_at FROM cloud_collection_lease WHERE id=1').get();
    if(lease?.owner!==batch.owner||Number(lease.expires_at)<=Date.now())return active(store);
    for(const outcome of outcomes) {
      const {claim}=outcome,task=claim.task;
      const token=store.db.prepare('SELECT owner,expires_at FROM cloud_task_claims WHERE task_id=?').get(task.id);
      if(token?.owner!==batch.owner||Number(token.expires_at)<=Date.now())continue;
      const current=store.db.prepare('SELECT t.*,r.state AS run_state FROM sync_tasks t JOIN sync_runs r ON r.id=t.run_id WHERE t.id=?').get(task.id);
      const unchanged=current?.state==='queued'&&Number(current.attempts)===task.attempts&&current.available_at===claim.reservedUntil;
      const canApply=unchanged&&['queued','running'].includes(String(current?.run_state))&&!outcome.cancelled;
      if(canApply) {
        if(outcome.result?.kind==='detail') {
          const version=store.db.prepare('SELECT updated_at FROM performances WHERE source=? AND source_id=?').get(task.source,task.source_id)?.updated_at;
          if(String(version||'')!==claim.itemVersion) {
            // Even an intervening list write can retain old detail. Re-read rather than certify it as fresh.
            store.db.prepare('UPDATE sync_tasks SET available_at=? WHERE id=?').run(new Date(Date.now()+1000).toISOString(),task.id);
            store.db.prepare('DELETE FROM cloud_task_claims WHERE task_id=? AND owner=?').run(task.id,batch.owner);
            continue;
          }
        }
        const attempted={...task,attempts:task.attempts+1};
        store.db.prepare("UPDATE sync_tasks SET state='running',attempts=?,available_at=? WHERE id=?").run(attempted.attempts,task.available_at,task.id);
        if(outcome.result)applyCollectionResult(store,attempted,outcome.result,{observedAt:claim.observedAt});
        else applyCollectionFailure(store,attempted,outcome.error,outcome.timedOut?'클라우드 수집 응답 시간이 초과됐습니다. 재시도 후에도 실패하면 해당 작업을 재개하세요.':undefined);
      }else if(unchanged) {
        // A paused or disconnected request keeps its pending task without consuming an attempt.
        store.db.prepare('UPDATE sync_tasks SET available_at=? WHERE id=?').run(task.available_at,task.id);
      }
      store.db.prepare('DELETE FROM cloud_task_claims WHERE task_id=? AND owner=?').run(task.id,batch.owner);
    }
    // A cross-instance successor waits at least one interval after this batch's final HTTP response.
    store.db.prepare("UPDATE cloud_collection_lease SET owner='',expires_at=0,next_request_at=? WHERE id=1 AND owner=?").run(Date.now()+INTERVAL_MS,batch.owner);
    return active(store);
  },{skipUnchanged:true});
}

export async function runCloudCollection(options:CloudCollectionOptions) {
  const budget=Math.min(35000,Math.max(1,options.tickBudgetMs??35000));
  const stepMs=Math.min(12000,Math.max(1,options.tickStepMs??12000));
  const deadline=Date.now()+budget;
  const blocked=new Set<Source>();
  const providers=options.providers?injectedProviders(options.providers,blocked):createCloudCollectionProviders({kopis:options.env.KOPIS_API_KEY||'',culture:options.env.CULTURE_API_KEY||''},fetch,blocked);
  let steps=0,hasActive=true,batches=0;
  while(steps<20&&Date.now()+stepMs<deadline&&!options.signal?.aborted) {
    const batch=await claimBatch(options,Math.min(8,20-steps));hasActive=batch.active;
    if(!batch.tasks.length)break; // Idle, backoff and another owner never rewrite snapshots repeatedly.
    const starts=Math.max(...SOURCES.map(source=>batch.tasks.filter(claim=>claim.task.source===source).length));
    const networkBudget=stepMs+Math.max(0,starts-1)*INTERVAL_MS+Math.max(0,batch.notBefore-Date.now());
    if(Date.now()+networkBudget>=deadline||options.signal?.aborted) {
      hasActive=await mergeBatch(options,batch,batch.tasks.map(claim=>({claim,cancelled:true})));
      break;
    }
    const outcomes=await fetchBatch(batch,providers,stepMs,blocked,options.signal);
    hasActive=await mergeBatch(options,batch,outcomes);
    steps+=batch.tasks.length;batches++;
    if(!hasActive||outcomes.some(outcome=>outcome.timedOut))break;
  }
  return {ok:true,steps,active:hasActive,continueWhileOpen:true,batches};
}
