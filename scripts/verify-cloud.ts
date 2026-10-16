import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { handleCloudRequest } from '../server/cloud/handler.js';
const env={...parse(readFileSync('.env')), ...parse(readFileSync('.env.vercel'))};
process.env.DATABASE_URL=env.DATABASE_URL;
const origin='https://culture-desk.example';
const call=(path:string,method='GET',body?:unknown)=>handleCloudRequest(new Request(origin+path,{
  method,headers:{...(body!==undefined?{'content-type':'application/json','x-culture-request':'1',origin}: {})},
  body:body===undefined?undefined:JSON.stringify(body),
}),{env});
try {
  assert.equal((await call('/api/bootstrap')).status,200);
  assert.equal((await call('/api/auth','POST',{password:'unused'})).status,404);
  const boot=await (await call('/api/bootstrap')).json();assert.equal(boot.deployment,'cloud');
  const map=await (await call('/api/map?from=2026-10-01&to=2026-10-31')).json();assert.ok(map.total>0);
  for(const item of map.items.slice(0,2)) {
    const detail=await (await call(`/api/performances/${item.id}`)).json();
    assert.ok(!detail.note);assert.ok(!detail.bookmarked);
    assert.equal((await call(`/api/performances/${item.id}/bookmark`,'PUT',{bookmarked:true,note:'unused'})).status,404);
  }
  assert.equal((await call('/api/cloud/backup')).status,404);
  assert.equal((await call('/api/cloud/cron')).status,401);
  console.log(JSON.stringify({passwordRequired:false,regions:boot.cities.length,total:map.total,venueCoordinates:map.items.filter((i:any)=>i.locationPrecision==='venue').length,
    personalDataHidden:true,managementEndpointsRemoved:true,cronProtected:true}));
} catch {
  console.error('Cloud integration check failed; sensitive details omitted.');process.exitCode=1;
}
