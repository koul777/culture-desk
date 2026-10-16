import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, isSearchRoute } from '../server/app.js';
import { Store } from '../server/store.js';
import { DEFAULT_CITIES } from '../server/providers/cities.js';
import type { PerformanceInput } from '../shared/types.js';

test('public building API resolves a stored performance ID and rejects arbitrary or excluded records', async t=>{
  const store=new Store(':memory:',DEFAULT_CITIES);
  const input:PerformanceInput={source:'kopis',sourceId:'TEST_BUILDING',title:'TEST 공연',cityId:'andong',
    startDate:'2026-10-01',endDate:'2026-10-31',genre:'음악',sourceGenre:'음악',venue:'TEST 공연장',
    address:'',poster:'',sourceUrl:'',price:'',priceType:'unknown',age:'',runtime:'',cast:'',producer:'',organizer:'',
    contact:'',schedule:'',description:'',status:'',detailState:'complete',classification:'performance',reviewReason:'',raw:null};
  const id=store.upsert(input);
  const excluded=store.upsert({...input,sourceId:'TEST_EXHIBITION',classification:'excluded'});
  const calls:number[]=[];
  const {app}=await createApp({port:4317,databasePath:':memory:',keys:{kopis:'',culture:''},requestIntervalMs:350,syncIntervalHours:24},
    {store,providers:{},startWorker:false,serveStatic:false,searchOnly:true,venueBuildings:{lookup:async item=>{
      calls.push(item.id);
      return {status:'unavailable',performanceId:item.id,building:null,source:'OpenStreetMap',attribution:'© OpenStreetMap contributors',reason:'no_venue_coordinates',message:'TEST 위치 없음',checkedAt:new Date().toISOString()};
    }}});
  t.after(async()=>{await app.close();store.close();});
  const success=await app.inject(`/api/venues/building?performanceId=${id}`);
  assert.equal(success.statusCode,200); assert.equal(success.json().performanceId,id);
  for(const query of ['', '?performanceId=bad','?performanceId=0','?latitude=37&longitude=127']) assert.equal((await app.inject('/api/venues/building'+query)).statusCode,400);
  for(const unknown of [999999,excluded]) assert.equal((await app.inject(`/api/venues/building?performanceId=${unknown}`)).statusCode,404);
  assert.deepEqual(calls,[id]);
  assert.equal(isSearchRoute('GET','/api/venues/building'),true);
  assert.equal(isSearchRoute('POST','/api/venues/building'),false);
});
