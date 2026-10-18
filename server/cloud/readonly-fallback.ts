import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { Performance, PublicRefreshStatus } from '../../shared/types.js';
import { Store } from '../store.js';
import { NATIONAL_CITIES } from '../providers/cities.js';
import { cleanVenueInfo } from '../venue-info.js';

/** Scheduled refresh state recorded when the snapshot was published. */
export type PublishedRefresh=Omit<PublicRefreshStatus,'schedule'>;
/** Region/source pairs ("kopis:andong") whose collection covered the whole from–to window. */
export interface PublishedCoverage {from:string;to:string;pairs:string[]}
export interface PublicReadonlySnapshot {
  version:1;snapshotAt:string;generatedAt?:string;
  refresh?:PublishedRefresh;coverage?:PublishedCoverage;
  performances:Array<Omit<Performance,'note'|'bookmarked'>>;
}
export interface ReadonlyFallbackOptions {
  artifactPath?:string;
  load?:()=>Promise<PublicReadonlySnapshot|undefined>;
  now?:()=>number;
}
export interface FallbackMetadata {mode:'snapshot';snapshotAt:string;reason:'database_unavailable'}
export interface ReadonlyModel {store:Store;metadata:FallbackMetadata;refresh?:PublishedRefresh}
export const DATABASE_RECHECK_MS=45000;
export const DATABASE_UNAVAILABLE_MESSAGE='저장소 연결이 제한되어 수집과 변경을 잠시 중단했습니다. 저장된 공개 자료는 임시 조회로 확인할 수 있습니다. 60초 후 다시 확인하세요.';
const DEFAULT_ARTIFACT=fileURLToPath(new URL('../assets/public-snapshot.json',import.meta.url));
const models=new Map<string|Function,Promise<ReadonlyModel|undefined>>();
const circuits=new WeakMap<object,{until:number;probing:boolean}>();
export const defaultDatabaseCircuit={};
export function mayAttemptDatabase(key:object,now:number):boolean {
  const state=circuits.get(key);if(!state)return true;
  if(now<state.until||state.probing)return false;
  state.probing=true;return true;
}
export function databaseSucceeded(key:object):void {circuits.delete(key);}
export function databaseFailed(key:object,now:number):void {circuits.set(key,{until:now+DATABASE_RECHECK_MS,probing:false});}
export function isReadonlyFallbackRoute(method:string,route:string):boolean {
  return ['GET','HEAD'].includes(method)&&(['/api/bootstrap','/api/performances','/api/map','/api/export.xlsx','/api/venues/building'].includes(route)||/^\/api\/performances\/[1-9]\d*$/.test(route));
}
function validDate(value:unknown):value is string {return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value));}
const PUBLIC_FIELDS=['source','sourceId','title','cityId','startDate','endDate','genre','sourceGenre','venue','address','poster','sourceUrl',
  'latitude','longitude','locationPrecision','price','priceType','age','runtime','cast','producer','organizer','contact','schedule','description','status','detailState','classification','reviewReason'] as const;
const isDay=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value);
const timeOrNull=(value:unknown)=>value===null||validDate(value);
function validRefresh(value:unknown):value is PublishedRefresh {
  const r=value as PublishedRefresh;
  const counts=r?.counts;
  return !!r&&typeof r==='object'&&['idle','running','retry_wait','failed','complete','unavailable'].includes(r.status)
    &&[r.day,r.from,r.to].every(day=>day===null||isDay(day))&&timeOrNull(r.lastSuccessAt)&&timeOrNull(r.updatedAt)
    &&(r.error===null||typeof r.error==='string')
    &&(counts===null||(typeof counts==='object'&&['expectedRuns','completeRuns','totalTasks','doneTasks','remaining','performances']
      .every(key=>Number.isSafeInteger((counts as unknown as Record<string,unknown>)[key]))));
}
/**
 * Inserts the public rows (and the audited coverage) into a store. Used for the in-memory read model
 * and to seed the scheduled collector when no earlier state exists.
 */
export function insertPublicSnapshot(store:Store,snapshot:PublicReadonlySnapshot):void {
  if(snapshot?.version!==1||!validDate(snapshot.snapshotAt)||!Array.isArray(snapshot.performances)||snapshot.performances.length>100000)throw new Error('Invalid public snapshot');
  if(snapshot.refresh!==undefined&&!validRefresh(snapshot.refresh))throw new Error('Invalid public snapshot refresh state');
  const coverage=snapshot.coverage;
  if(coverage!==undefined&&(!isDay(coverage.from)||!isDay(coverage.to)||coverage.from>coverage.to||!Array.isArray(coverage.pairs)))throw new Error('Invalid public snapshot coverage');
  const cities=new Set(NATIONAL_CITIES.map(city=>city.id));
  store.transaction(()=>{
    const insert=store.db.prepare('INSERT INTO performances(id,source,source_id,city_id,start_date,end_date,classification,detail_state,data,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
    for(const item of snapshot.performances){
      if(!Number.isSafeInteger(item.id)||item.id<1||!['kopis','culture'].includes(item.source)||typeof item.sourceId!=='string'||!item.sourceId||
        typeof item.cityId!=='string'||typeof item.title!=='string'||item.classification!=='performance'||!validDate(item.updatedAt)||
        !['pending','complete','failed'].includes(item.detailState)||!isDay(item.startDate)||!isDay(item.endDate))throw new Error('Invalid public performance');
      const safe:Record<string,unknown>=Object.fromEntries(PUBLIC_FIELDS.filter(field=>item[field]!==undefined).map(field=>[field,item[field]]));
      const venueInfo=cleanVenueInfo(item.venueInfo,typeof item.venue==='string'?item.venue:'');if(venueInfo)safe.venueInfo=venueInfo;
      insert.run(item.id,item.source,item.sourceId,item.cityId,item.startDate,item.endDate,'performance',item.detailState,JSON.stringify(safe),item.updatedAt);
    }
    // Only audited, complete region/source coverage is recorded, so searches do not report a false gap.
    const run=store.db.prepare("INSERT INTO sync_runs(source,city_id,from_date,to_date,state,created_at,updated_at,detail_only) VALUES(?,?,?,?,'complete',?,?,0)");
    for(const pair of coverage?.pairs??[]){
      const [source,city]=String(pair).split(':');
      if(!['kopis','culture'].includes(source)||!cities.has(city))throw new Error('Invalid public snapshot coverage');
      run.run(source,city,coverage!.from,coverage!.to,snapshot.snapshotAt,snapshot.snapshotAt);
    }
  });
}
/** No original payloads, personal notes, bookmarks, or background work are loaded. */
export function hydrateReadonlySnapshot(snapshot:PublicReadonlySnapshot):ReadonlyModel {
  const store=new Store(':memory:',NATIONAL_CITIES);
  try {
    insertPublicSnapshot(store,snapshot);
    store.db.exec('PRAGMA query_only=ON');
    return {store,metadata:{mode:'snapshot',snapshotAt:snapshot.snapshotAt,reason:'database_unavailable'},...(snapshot.refresh?{refresh:snapshot.refresh}:{})};
  }catch(error){store.close();throw error;}
}
export async function readPublicSnapshot(file:string):Promise<PublicReadonlySnapshot> {
  const bytes=await readFile(file);
  const text=file.endsWith('.gz')?gunzipSync(bytes,{maxOutputLength:64*1024*1024}).toString('utf8'):bytes.toString('utf8');
  if(text.length>64*1024*1024)throw new Error('Public snapshot exceeds the decoded size budget');
  return JSON.parse(text) as PublicReadonlySnapshot;
}
export function loadReadonlyFallback(options:ReadonlyFallbackOptions={}):Promise<ReadonlyModel|undefined> {
  const key=options.load||options.artifactPath||DEFAULT_ARTIFACT;
  let cached=models.get(key);
  if(!cached){cached=(async()=>{
    try {
      const snapshot=options.load?await options.load():await readPublicSnapshot(options.artifactPath||DEFAULT_ARTIFACT);
      return snapshot?hydrateReadonlySnapshot(snapshot):undefined;
    }catch{return undefined;} // No fallback is safer than serving an incomplete or malformed artifact.
  })();models.set(key,cached);}
  return cached;
}
export function unavailableRefresh(enabled:boolean):PublicRefreshStatus&{enabled:boolean} {
  return {enabled,status:'unavailable',day:null,from:null,to:null,lastSuccessAt:null,updatedAt:null,counts:null,error:'저장소 연결 제한으로 자동 갱신 상태를 확인할 수 없습니다.',
    schedule:{timezone:'Asia/Seoul',primary:'04:17',retries:['06:47','12:47','20:47']}};
}
export async function annotateReadonlyExport(bytes:Buffer,metadata:FallbackMetadata):Promise<Buffer> {
  const { default: ExcelJS } = await import('exceljs');
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(bytes as any);
  const evidence=workbook.getWorksheet('조회 근거')||workbook.addWorksheet('조회 근거');
  evidence.addRow(['임시 조회 자료','저장소 연결 제한으로 제공하는 공개 스냅샷입니다. 현재 수집·갱신 완료를 의미하지 않습니다.']);
  evidence.addRow(['스냅샷 기준 시각',metadata.snapshotAt]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
