import Fastify from 'fastify';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { readConfig, ROOT } from './config.js';
import { Store } from './store.js';
import { Worker } from './worker.js';
import { NATIONAL_CITIES } from './providers/cities.js';
import { isDate, today } from './dates.js';
import { exportWorkbook } from './export.js';
import { VenueBuildingService } from './venue-buildings.js';
import { handleVWorldRequest, isVWorldRoute } from './vworld.js';
import { buildMapResult } from './map-response.js';
import type { SearchPerformanceTrace } from './search-performance.js';
import type { City, Performance, Provider, SearchFilters, Source, SyncRequest } from '../shared/types.js';

const venueBuildings = new VenueBuildingService();

function bad(message: string, statusCode=400): never { throw Object.assign(new Error(message),{statusCode}); }
function object(value: unknown): Record<string,any> { if(!value || typeof value!=='object' || Array.isArray(value)) bad('요청 내용을 확인하세요.'); return value as Record<string,any>; }
function validId(value: unknown): number { const n=Number(value); if(!Number.isSafeInteger(n)||n<1) bad('올바른 항목을 선택하세요.'); return n; }
export function isSearchRoute(method: string, pathname: string): boolean {
  const route=pathname.replace(/\/$/,'');
  if(['GET','HEAD'].includes(method)) return ['/api/health','/api/bootstrap','/api/performances','/api/map','/api/venues/building','/api/export.xlsx'].includes(route)||isVWorldRoute(route)||/^\/api\/performances\/[1-9]\d*$/.test(route);
  return method==='POST'&&(['/api/sync','/api/details'].includes(route)||/^\/api\/sync\/[1-9]\d*\/(pause|resume)$/.test(route)||/^\/api\/performances\/[1-9]\d*\/detail$/.test(route));
}
function filtersFrom(value: unknown): SearchFilters {
  const allowed=['cities','from','to','genre','q','status','price','age','source','bookmarked','page','limit']; const result:Record<string,string>={};
  if(value && typeof value==='object') for(const [key,item] of Object.entries(value)) { if(allowed.includes(key)) { if(typeof item!=='string'||item.length>(key==='cities'?15000:1000)) bad('검색 조건을 확인하세요.'); result[key]=item; } }
  if((result.from&&!isDate(result.from))||(result.to&&!isDate(result.to))||(result.from&&result.to&&result.from>result.to)) bad('올바른 조회 기간을 선택하세요.');
  if(result.source&&!['kopis','culture'].includes(result.source)) bad('출처를 확인하세요.');
  if(result.price&&!['free','paid','unknown'].includes(result.price)) bad('관람료 조건을 확인하세요.');
  if(result.status&&!['upcoming','ongoing','ended'].includes(result.status)) bad('공연 상태를 확인하세요.');
  if(result.bookmarked&&!['true','false'].includes(result.bookmarked)) bad('관심 공연 조건을 확인하세요.');
  for(const key of ['page','limit']) if(result[key]&&(!/^[1-9]\d*$/.test(result[key])||!Number.isSafeInteger(Number(result[key]))||Number(result[key])>(key==='limit'?100:1000000))) bad('페이지와 조회 건수는 올바른 양의 정수로 입력하세요.');
  return result as SearchFilters;
}
export async function createApp(config: Config, options: { store?:Store; providers?:Partial<Record<Source,Provider>>; startWorker?:boolean; serveStatic?:boolean; searchOnly?:boolean; allowLocalManagement?:boolean; shutdown?:()=>void; configLoader?:()=>Config; venueBuildings?:Pick<VenueBuildingService,'lookup'>; readonlySnapshotAt?:string; performanceTrace?:SearchPerformanceTrace }={}) {
  const store=options.store||new Store(config.databasePath,NATIONAL_CITIES,{performanceTrace:options.performanceTrace});
  const worker=new Worker(store,config,options.providers);
  let vworld=config.vworld;
  const visibleItem=(item: Performance): Performance=>options.searchOnly?{...item,note:'',bookmarked:false}:item;
  const searchFilters=(value: unknown): SearchFilters=>{
    const filters=filtersFrom(value);
    if(options.searchOnly&&filters.bookmarked)bad('지원하지 않는 조회 조건입니다.');
    return filters;
  };
  const app=Fastify({logger:false,bodyLimit:256*1024});
  if(options.performanceTrace){
    const started=new WeakMap<object,number>();
    app.addHook('preSerialization',(request,_reply,payload,done)=>{started.set(request,performance.now());done(null,payload);});
    app.addHook('onSend',(request,_reply,payload,done)=>{
      const at=started.get(request);
      if(at!==undefined)options.performanceTrace!({phase:'fastify.serialize',durationMs:performance.now()-at,
        ...(typeof payload==='string'?{bytes:Buffer.byteLength(payload)}:Buffer.isBuffer(payload)?{bytes:payload.byteLength}:{})});
      done(null,payload);
    });
  }
  app.addHook('onRequest',async(request,reply)=>{
    const hostname=request.headers.host?.split(':')[0];
    if(hostname && !['127.0.0.1','localhost'].includes(hostname)) return reply.code(403).send({error:'로컬 컴퓨터에서만 사용할 수 있습니다.'});
    const pathname=new URL(request.url,'http://localhost').pathname.replace(/\/$/,'');
    if(isVWorldRoute(pathname)&&!['GET','HEAD'].includes(request.method))return reply.code(405).header('Allow','GET, HEAD').send({error:'조회 요청만 허용됩니다.'});
    const localManagement=options.allowLocalManagement&&request.method==='POST'&&['/api/backup','/api/shutdown','/api/config/reload','/api/cities'].includes(pathname);
    if(options.searchOnly&&request.url.startsWith('/api/')&&!isSearchRoute(request.method,pathname)&&!localManagement)return reply.code(404).send({error:'요청을 찾을 수 없습니다.'});
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','strict-origin-when-cross-origin');
    if(!['GET','HEAD','OPTIONS'].includes(request.method)) {
      if(request.headers['x-culture-request']!=='1') return reply.code(403).send({error:'프로그램 화면에서 다시 시도하세요.'});
      if(request.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json') return reply.code(415).send({error:'JSON 형식으로 요청하세요.'});
      const origin=request.headers.origin;
      const allowed=[`http://127.0.0.1:${config.port}`,`http://localhost:${config.port}`,'http://127.0.0.1:5173','http://localhost:5173','http://127.0.0.1:5317','http://localhost:5317'];
      if(origin&&!allowed.includes(origin)) return reply.code(403).send({error:'허용되지 않은 요청입니다.'});
    }
  });
  app.setErrorHandler((error,_request,reply)=>{const e=error as {statusCode?:number;message:string};const status=e.statusCode&&e.statusCode>=400&&e.statusCode<500?e.statusCode:500; reply.code(status).send({error:status<500?e.message:'작업을 처리하지 못했습니다. 잠시 후 다시 시도하세요.'});});
  app.get('/api/health',async()=>({ok:true,app:'culture-desk'}));
  for(const route of ['/api/maps/vworld/config','/api/maps/vworld/frame'])app.get(route,async(request,reply)=>{
    const base=`${request.protocol}://${request.headers.host||`localhost:${config.port}`}`;
    const response=handleVWorldRequest(new Request(new URL(request.url,base),{method:request.method}),vworld)!;
    response.headers.forEach((value,key)=>reply.header(key,value));
    return reply.code(response.status).send(request.method==='HEAD'?undefined:await response.text());
  });
  app.get('/api/bootstrap',async()=>{
    const counts=store.counts(); const runs=store.runs(2000);
    return {cities:store.cities(),sources:(['kopis','culture'] as Source[]).map(source=>({source,label:source==='kopis'?'KOPIS':'문화포털',configured:!!worker.providers[source],count:counts.source[source],lastSync:store.lastCollectionSync(source),
      applicationUrl:source==='kopis'?'https://kopis.or.kr/por/cs/openapi/openApiInfo.do?menuId=MNU_00074':'https://www.data.go.kr/data/15138937/openapi.do'})),bookmarkCount:options.searchOnly?0:counts.bookmarks,pendingDetails:counts.pending,reviewCount:counts.review,excludedCount:counts.excluded,runs,today:today()};
  });
  app.get('/api/performances',async request=>{const result=store.search(searchFilters(request.query));return {...result,
    ...(options.readonlySnapshotAt?{snapshotAt:options.readonlySnapshotAt}:{}),items:result.items.map(visibleItem)};});
  app.get('/api/map',async request=>{
    const result=store.searchMap(searchFilters(request.query));
    return buildMapResult({...result,...(options.readonlySnapshotAt?{snapshotAt:options.readonlySnapshotAt}:{})},options.performanceTrace);
  });
  app.get<{Params:{id:string}}>('/api/performances/:id',async request=>visibleItem(store.item(validId(request.params.id))||bad('공연을 찾을 수 없습니다.',404)));
  app.get<{Querystring:{performanceId?:string}}>('/api/venues/building',async request=>{
    const item=store.item(validId(request.query.performanceId));
    if(!item||item.classification!=='performance')bad('공연을 찾을 수 없습니다.',404);
    return (options.venueBuildings||venueBuildings).lookup(item);
  });
  app.put<{Params:{id:string}}>('/api/performances/:id/bookmark',async request=>{
    const body=object(request.body); if(typeof body.bookmarked!=='boolean'||(body.note!==undefined&&(typeof body.note!=='string'||body.note.length>20000))) bad('메모는 20,000자 이내로 입력하세요.');
    const id=validId(request.params.id); if(!store.item(id)) bad('공연을 찾을 수 없습니다.',404);
    return store.bookmark(id,body.bookmarked,body.note);
  });
  app.post<{Params:{id:string}}>('/api/performances/:id/detail',async request=>{
    const item=store.item(validId(request.params.id)); if(!item) bad('공연을 찾을 수 없습니다.',404);
    if(!worker.providers[item.source]) bad('해당 출처의 API 키를 먼저 입력하세요.');
    worker.enqueueDetail(item.source,item.sourceId); return {queued:true};
  });
  app.post('/api/details',async request=>({queued:worker.enqueueDetails(searchFilters(object(request.body).filters))}));
  app.post('/api/sync',async request=>{
    const b=object(request.body);
    const knownCities=new Set(store.cities().map(city=>city.id));
    if(!Array.isArray(b.cities)||!b.cities.length||b.cities.length>1000||!b.cities.every((c:unknown)=>typeof c==='string'&&knownCities.has(c))) bad('수집할 지역을 선택하세요.');
    if(!Array.isArray(b.sources)||!b.sources.length||!b.sources.every((s:unknown)=>s==='kopis'||s==='culture')) bad('수집할 출처를 선택하세요.');
    if(typeof b.from!=='string'||typeof b.to!=='string'||!isDate(b.from)||!isDate(b.to)||b.from>b.to) bad('올바른 수집 기간을 선택하세요.');
    if(Date.parse(b.to)-Date.parse(b.from)>366*5*86400000) bad('한 번에 최대 5년 범위로 나누어 수집하세요.');
    return worker.enqueue({cities:[...new Set(b.cities)],sources:[...new Set(b.sources)],from:b.from,to:b.to} as SyncRequest);
  });
  app.post<{Params:{id:string}}>('/api/sync/:id/pause',async request=>{store.setRunState(validId(request.params.id),'paused');return{ok:true};});
  app.post<{Params:{id:string}}>('/api/sync/:id/resume',async request=>{store.setRunState(validId(request.params.id),'queued');return{ok:true};});
  app.get('/api/export.xlsx',async(request,reply)=>{
    const filters=searchFilters(request.query); const idsText=(request.query as Record<string,string>).ids;
    const ids=idsText?idsText.split(',').map(validId):undefined;
    const data=await exportWorkbook(store,filters,ids,{includeNotes:!options.searchOnly});
    return reply.header('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition',`attachment; filename="culture-desk-${today()}.xlsx"`).send(data);
  });
  app.post('/api/cities',async request=>{
    const b=object(request.body);
    for(const key of ['name','sido','sigungu','kopisSido','kopisSigungu']) if(typeof b[key]!=='string'||!b[key].trim()||b[key].length>50) bad('도시명·시도·시군구와 KOPIS 코드를 모두 입력하세요.');
    if(!/^\d{2}$/.test(b.kopisSido)||!/^\d{4}$/.test(b.kopisSigungu)) bad('KOPIS 시도 2자리·시군구 4자리 코드를 확인하세요.');
    if(store.cities().some(c=>c.sido===b.sido&&c.sigungu===b.sigungu)) bad('이미 등록된 도시입니다.');
    const city:City={id:'city-'+randomUUID().slice(0,8),name:b.name.trim(),sido:b.sido.trim(),sigungu:b.sigungu.trim(),kopisSido:b.kopisSido,kopisSigungu:b.kopisSigungu,aliases:[b.name.trim(),b.sigungu.trim()]};
    return store.addCity(city);
  });
  app.post('/api/config/reload',async()=>{const fresh=(options.configLoader||readConfig)();vworld=fresh.vworld; worker.configure({...config,keys:fresh.keys,vworld:fresh.vworld,requestIntervalMs:fresh.requestIntervalMs,syncIntervalHours:fresh.syncIntervalHours});return{ok:true};});
  app.post('/api/backup',async()=>{
    const dir=path.join(path.dirname(config.databasePath),'backups'); mkdirSync(dir,{recursive:true});
    const filename=`culture-${new Date().toISOString().replace(/[:.]/g,'-')}.db`;store.backup(path.join(dir,filename));return{filename};
  });
  app.post('/api/shutdown',async()=>{if(options.shutdown)setTimeout(options.shutdown,150).unref();return{ok:true};});
  const clientDir=path.join(ROOT,'dist/client');
  if(options.serveStatic!==false && existsSync(path.join(clientDir,'index.html'))) {
    const {default:fastifyStatic}=await import('@fastify/static');
    await app.register(fastifyStatic,{root:clientDir,decorateReply:true});
    app.setNotFoundHandler((request,reply)=>request.url.startsWith('/api/')?reply.code(404).send({error:'요청을 찾을 수 없습니다.'}):reply.sendFile('index.html'));
  }
  app.addHook('onClose',async()=>{await worker.stop();if(!options.store)store.close();});
  if(options.startWorker!==false)worker.start();
  return {app,store,worker};
}
