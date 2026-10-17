import type { Provider, PublicRefreshStatus, Source } from '../../shared/types.js';
import type { Config } from '../config.js';
import { createApp, isSearchRoute } from '../app.js';
import type { Store } from '../store.js';
import { getSnapshotRepository, SnapshotCapacityError, type SnapshotRepository } from './snapshot.js';
import { equalSecret, validMutationOrigin } from './auth.js';
import { getRefreshJobRepository, REFRESH_SCHEDULE } from './refresh-jobs.js';
import { runCloudCollection } from './collection.js';
import { handleVWorldRequest, isVWorldRoute } from '../vworld.js';
import { annotateReadonlyExport, databaseFailed, databaseSucceeded, defaultDatabaseCircuit, DATABASE_UNAVAILABLE_MESSAGE,
  isReadonlyFallbackRoute, loadReadonlyFallback, mayAttemptDatabase, unavailableRefresh,
  type ReadonlyFallbackOptions, type ReadonlyModel } from './readonly-fallback.js';

type Repository = Pick<SnapshotRepository, 'withStore'>;
export interface CloudOptions {
  env?: NodeJS.ProcessEnv;
  repository?: Repository;
  providers?: Partial<Record<Source, Provider>>;
  tickBudgetMs?: number;
  tickStepMs?: number;
  refreshStatus?: () => Promise<PublicRefreshStatus>;
  readonlyFallback?: ReadonlyFallbackOptions;
}
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' };
export const MAX_API_RESPONSE_BYTES = 4 * 1024 * 1024;
const capacityMessage = '조회 결과가 다운로드 한도를 초과했습니다. 지역·기간 등 조회 조건을 좁혀 다시 시도하세요.';
function vworldRequest(request:Request,url:URL):Request {
  // Vercel's /api/:path* rewrite forwards its unused capture as a query parameter.
  // Remove only the single exact capture for this route; user input remains strict.
  if(!['GET','HEAD'].includes(request.method.toUpperCase())||!isVWorldRoute(url.pathname))return request;
  const captures=url.searchParams.getAll('path');
  if(captures.length!==1||captures[0]!==url.pathname.slice('/api/'.length))return request;
  const normalized=new URL(url);normalized.searchParams.delete('path');
  return new Request(normalized,request);
}
function json(body: unknown, status = 200, extra: Record<string,string> = {}): Response {
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) > MAX_API_RESPONSE_BYTES) return responseCapacity();
  return new Response(serialized, { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra } });
}
function responseCapacity(): Response { return json({ code: 'RESPONSE_CAPACITY', error: capacityMessage }, 413); }
async function automaticRefreshStatus(options: CloudOptions): Promise<PublicRefreshStatus & {enabled:true}> {
  try {
    return { ...(await (options.refreshStatus ? options.refreshStatus() : getRefreshJobRepository().publicStatus())), enabled:true };
  } catch {
    return {enabled:true,status:'unavailable',day:null,from:null,to:null,lastSuccessAt:null,updatedAt:null,counts:null,
      error:'자동 갱신 상태를 확인하지 못했습니다. 잠시 후 다시 확인하세요.',
      schedule:{timezone:'Asia/Seoul',primary:'04:17',retries:['06:47','12:47','20:47']}};
  }
}
function cloudConfig(store: Store, env: NodeJS.ProcessEnv): Config {
  return { port: 4317, databasePath: store.filename, keys: { kopis: (env.KOPIS_API_KEY || '').trim(), culture: (env.CULTURE_API_KEY || '').trim() }, vworld:{apiKey:(env.VWORLD_API_KEY||'').trim()}, requestIntervalMs: 350, syncIntervalHours: 24 };
}
async function payload(request: Request): Promise<string | Response> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: 'JSON 형식으로 요청하세요.' }, 415);
  if (Number(request.headers.get('content-length')) > 256 * 1024) return json({ error: '요청이 너무 큽니다.' }, 413);
  const body = await request.text();
  if (Buffer.byteLength(body) > 256 * 1024) return json({ error: '요청이 너무 큽니다.' }, 413);
  try { JSON.parse(body); return body; } catch { return json({ error: '요청 내용을 확인하세요.' }, 400); }
}
function publishedRefresh(model:ReadonlyModel):PublicRefreshStatus&{enabled:true} {
  return model.refresh?{...model.refresh,schedule:REFRESH_SCHEDULE,enabled:true}
    :{...unavailableRefresh(true),enabled:true,error:'자동 갱신 기록이 없는 자료입니다. 다음 예약 실행에서 갱신합니다.'};
}
/** Published data: a read model of the snapshot the scheduled job committed. Nothing is collected here. */
async function servePublished(request:Request,options:CloudOptions):Promise<Response> {
  const method=request.method.toUpperCase(),route=new URL(request.url).pathname.replace(/\/$/,'');
  if(!isReadonlyFallbackRoute(method,route))return json({error:'요청을 찾을 수 없습니다.'},404);
  const model=await loadReadonlyFallback(options.readonlyFallback);
  if(!model){
    const response=json({code:'SNAPSHOT_UNAVAILABLE',error:'공연 자료를 불러오지 못했습니다. 잠시 후 다시 시도하세요.'},503,{'Retry-After':'60'});
    return method==='HEAD'?new Response(null,{status:response.status,headers:response.headers}):response;
  }
  return serveStoredRequest(model.store,request,options,undefined,model,true);
}
async function serveStoredRequest(store:Store,request:Request,options:CloudOptions,body?:string,fallback?:ReadonlyModel,published=false):Promise<Response> {
  const env=options.env||process.env,url=new URL(request.url),route=url.pathname.replace(/\/$/,''),method=request.method.toUpperCase();
  const capacity=()=>{const response=responseCapacity();return method==='HEAD'?new Response(null,{status:response.status,headers:response.headers}):response;};
  const config=cloudConfig(store,env);
  const runtime=await createApp(config,{store,providers:fallback?{}:options.providers,startWorker:false,serveStatic:false,searchOnly:true,configLoader:()=>config});
  try {
    // HEAD executes the same read path but returns no body, including fallback metadata transformations.
    const injected=await runtime.app.inject({method:(method==='HEAD'?'GET':method) as any,url:url.pathname+url.search,
      headers:{host:'localhost:4317','x-culture-request':'1',...(body!==undefined?{'content-type':'application/json'}:{})},payload:body});
    if(injected.statusCode>=500)throw new Error('Local request failed');
    if(injected.rawPayload.byteLength>MAX_API_RESPONSE_BYTES)return capacity();
    let response:Response;
    if(route==='/api/bootstrap'&&injected.statusCode===200){
      const bootstrap=injected.json();bootstrap.deployment='cloud';
      bootstrap.runtime={mode:'cloud',backgroundSync:!fallback&&env.AUTOMATIC_REFRESH_ENABLED==='1'};
      if(fallback&&published){
        const refresh=publishedRefresh(fallback);
        bootstrap.published={mode:'published',snapshotAt:fallback.metadata.snapshotAt};bootstrap.runs=[];
        // Both provider keys are used by the scheduled job, not by this deployment.
        bootstrap.sources=bootstrap.sources.map((source:any)=>({...source,lastSync:refresh.lastSuccessAt,configured:true}));
        bootstrap.automaticRefresh=refresh;
      }else if(fallback){
        bootstrap.fallback=fallback.metadata;bootstrap.runs=[];
        bootstrap.sources=bootstrap.sources.map((source:any)=>({...source,lastSync:null,configured:!!(source.source==='kopis'?env.KOPIS_API_KEY:env.CULTURE_API_KEY)}));
        bootstrap.automaticRefresh=unavailableRefresh(env.AUTOMATIC_REFRESH_ENABLED==='1');
      }else if(env.AUTOMATIC_REFRESH_ENABLED==='1')bootstrap.automaticRefresh=await automaticRefreshStatus(options);
      response=json(bootstrap);
    }else if(fallback&&['/api/performances','/api/map'].includes(route)&&injected.statusCode===200){
      response=json({...injected.json<Record<string,unknown>>(),snapshotAt:fallback.metadata.snapshotAt,...(published?{}:{fallback:fallback.metadata})});
    }else{
      const responseHeaders=new Headers(headers);
      for(const name of ['content-type','content-disposition'])if(injected.headers[name])responseHeaders.set(name,String(injected.headers[name]));
      const bytes=fallback&&!published&&route==='/api/export.xlsx'&&injected.statusCode===200?await annotateReadonlyExport(injected.rawPayload,fallback.metadata):injected.rawPayload;
      if(bytes.byteLength>MAX_API_RESPONSE_BYTES)return capacity();
      response=new Response(new Uint8Array(bytes),{status:injected.statusCode,headers:responseHeaders});
    }
    if(fallback){response.headers.set('X-Culture-Data-Mode',published?'published':'snapshot');response.headers.set('X-Culture-Snapshot-At',fallback.metadata.snapshotAt);}
    return method==='HEAD'?new Response(null,{status:response.status,headers:response.headers}):response;
  }finally{await runtime.app.close();}
}
async function databaseUnavailable(request:Request,options:CloudOptions):Promise<Response> {
  const model=await loadReadonlyFallback(options.readonlyFallback);
  const route=new URL(request.url).pathname.replace(/\/$/,'');
  if(model&&isReadonlyFallbackRoute(request.method.toUpperCase(),route)){
    try{return await serveStoredRequest(model.store,request,options,undefined,model);}catch{/* Preserve a safe unavailable response if an artifact cannot serve the route. */}
  }
  const response=json({code:'DATABASE_UNAVAILABLE',error:DATABASE_UNAVAILABLE_MESSAGE,retryAfterSeconds:60,...(model?{fallback:model.metadata}:{})},503,{'Retry-After':'60'});
  return request.method==='HEAD'?new Response(null,{status:response.status,headers:response.headers}):response;
}
export async function handleCloudRequest(request: Request, options: CloudOptions = {}): Promise<Response> {
  const env = options.env || process.env;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const route = url.pathname.replace(/\/$/, '');
  const vworld=handleVWorldRequest(vworldRequest(request,url),{apiKey:env.VWORLD_API_KEY||''});
  if(vworld)return vworld; // No snapshot hydration, DB connection, or collection credentials in map frames.
  if (route === '/api/health' && method === 'GET') return json({ ok: true, app: 'culture-desk', deployment: 'cloud' });
  // The scheduled GitHub job publishes the data. The database path remains only for an explicit opt-in.
  if (!options.repository && env.CULTURE_DATA_SOURCE !== 'database') return servePublished(request, options);
  const cron = route === '/api/cloud/cron';
  if (cron) {
    if (method !== 'GET' || !equalSecret(request.headers.get('authorization') || '', env.CRON_SECRET ? `Bearer ${env.CRON_SECRET}` : '')) return json({ error: '인증이 필요합니다.' }, 401);
  }
  if(!cron&&!isSearchRoute(method,route)&&!(route==='/api/cloud/tick'&&method==='POST'))return json({error:'요청을 찾을 수 없습니다.'},404);
  let body: string | undefined;
  if (!['GET','HEAD','OPTIONS'].includes(method)) {
    if (!validMutationOrigin(request)) return json({ error: '허용되지 않은 요청입니다.' }, 403);
    const parsed = await payload(request); if (parsed instanceof Response) return parsed; body = parsed;
  }
  const circuit=options.repository||defaultDatabaseCircuit,now=()=>options.readonlyFallback?.now?.()??Date.now();
  if(!mayAttemptDatabase(circuit,now()))return databaseUnavailable(request,options);
  try {
    const repo = options.repository || getSnapshotRepository();
    if (cron && env.AUTOMATIC_REFRESH_ENABLED === '1') {
      const status=await automaticRefreshStatus(options);
      if(status.status==='unavailable')databaseFailed(circuit,now());else databaseSucceeded(circuit);
      return json({ok:true,automaticRefresh:status});
    }
    if ((route === '/api/cloud/tick' && method === 'POST') || cron) {
      const result=await runCloudCollection({...options,repository:repo,env,signal:request.signal});databaseSucceeded(circuit);return json(result);
    }
    const write = !['GET','HEAD'].includes(method);
    const result=await repo.withStore(write,store=>serveStoredRequest(store,request,options,body));
    databaseSucceeded(circuit);
    return result;
  } catch (error) {
    if (error instanceof SnapshotCapacityError) {databaseSucceeded(circuit);return json({ code: 'SNAPSHOT_CAPACITY', error: '저장 공간 한도에 도달했습니다. 수집 범위를 줄이거나 저장소를 확장하세요. 기존 자료는 유지됩니다.' }, 507);}
    databaseFailed(circuit,now());
    // Never return database URLs, API request URLs, keys, stack traces, or provider payloads.
    // Log only an error identifier and code locations; messages can contain credentials.
    const failure=error as {name?:string;code?:string;stack?:string};
    console.error(JSON.stringify({event:'culture_cloud_failure',
      type:/^[A-Za-z]+$/.test(failure.name||'')?failure.name:'Error',
      code:/^[A-Z_0-9]+$/.test(failure.code||'')?failure.code:undefined,
      locations:failure.stack?.split('\n').filter(line=>/^\s+at /.test(line)).slice(0,4).map(line=>line.replace(/https?:\/\/\S+/g,'[url]'))}));
    return databaseUnavailable(request,options);
  }
}
