import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
const origin='https://culture-desk.vercel.app';
const report={at:new Date().toISOString(),origin,reads:[],checks:{}};
async function get(path,json=true){const start=performance.now();const response=await fetch(origin+path);const body=json?await response.json():Buffer.from(await response.arrayBuffer());report.reads.push({path,status:response.status,ms:Math.round(performance.now()-start),mode:response.headers.get('x-culture-data-mode')});assert.equal(response.status,200);return {response,body};}
const {body:boot}=await get('/api/bootstrap');
const {body:search}=await get('/api/performances?from=2026-10-01&to=2027-01-16&limit=1');
const {body:map}=await get('/api/map?from=2026-10-01&to=2027-01-16');
const {body:config}=await get('/api/maps/vworld/config');
assert.equal(config.available,true);assert.deepEqual(Object.keys(config),['available']);
assert.equal(search.total,5615);assert.equal(map.total,search.total);assert.equal(map.truncated,false);
assert.equal(boot.fallback?.snapshotAt,'2026-10-16T11:19:02.370Z');
assert.equal(boot.automaticRefresh.status,'unavailable');assert.equal(boot.runtime.backgroundSync,false);
report.checks={snapshotAt:boot.fallback.snapshotAt,total:search.total,mapItems:map.items.length,located:map.items.filter(x=>x.locationPrecision==='venue').length,automaticRefresh:boot.automaticRefresh.status,vworldAvailable:config.available};
const {body:region}=await get('/api/performances?cities=wonju&from=2026-10-01&to=2027-01-16&limit=100');
assert.ok(region.total>0&&region.total<search.total);assert.ok(region.items.every(x=>x.cityId==='wonju'));report.checks.region={city:'wonju',total:region.total};
const {body:detail}=await get('/api/performances/149');assert.equal(detail.id,149);assert.ok(!('raw'in detail));assert.equal(detail.note,'');assert.equal(detail.bookmarked,false);
const {body:excel}=await get('/api/export.xlsx?cities=wonju&from=2026-10-01&to=2027-01-16',false);assert.equal(excel.subarray(0,2).toString(),'PK');report.checks.excelBytes=excel.length;
const frame=await fetch(origin+'/api/maps/vworld/frame?lat=37.3418293&lon=127.9194676&label=Venue&channel=deploymentCheck');
assert.equal(frame.status,200);assert.equal(frame.headers.get('x-frame-options'),'SAMEORIGIN');assert.match(frame.headers.get('content-security-policy')||'',/frame-ancestors 'self'/);report.checks.frame={status:frame.status,frameOptions:frame.headers.get('x-frame-options')};
const home=await fetch(origin);assert.equal(home.status,200);assert.equal(home.headers.get('x-frame-options'),'DENY');report.checks.home={status:home.status,frameOptions:home.headers.get('x-frame-options')};
// Empty cities fail validation even if the database recovers during this check; no work can be enqueued.
const mutation=await fetch(origin+'/api/sync',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Culture-Request':'1'},body:JSON.stringify({cities:[],sources:[],from:'2026-10-01',to:'2026-10-16'})});
assert.equal(mutation.status,503);assert.equal(mutation.headers.get('retry-after'),'60');report.checks.invalidCollectionBlocked={status:mutation.status,retryAfter:mutation.headers.get('retry-after')};
report.success=true;await writeFile('docs/verification/vworld-recovery-production-api.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
