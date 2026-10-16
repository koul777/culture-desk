import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCloudRequest } from '../server/cloud/handler.js';
import { handleVWorldRequest } from '../server/vworld.js';

const route='/api/maps/vworld/frame';
const key='TEST_BROWSER_ROUTING_KEY';
const params=()=>new URLSearchParams({lat:'37.3418293',lon:'127.9194676',label:'Venue',channel:'deploymentCheck'});
const request=(query:URLSearchParams,method='GET',pathname=route)=>new Request(`https://culture.test${pathname}?${query}`,{method});

test('Vercel exact rewrite capture is removed only at the cloud boundary for GET and HEAD map frames',async()=>{
  let databaseCalls=0;
  const repository={withStore:async()=>{databaseCalls++;throw new Error('Maps must not access the database');}};
  const env={VWORLD_API_KEY:key,KOPIS_API_KEY:'TEST_PRIVATE_SOURCE_KEY',DATABASE_URL:'TEST_PRIVATE_DATABASE'};
  for(const pathname of [route,`${route}/`]){
    const query=params();query.set('path',pathname.slice('/api/'.length));
    assert.equal(handleVWorldRequest(request(query,'GET',pathname),{apiKey:key})!.status,400,'local input stays strict');
    for(const method of ['GET','HEAD']){
      const response=await handleCloudRequest(request(query,method,pathname),{env,repository});
      assert.equal(response.status,200);assert.match(response.headers.get('content-type')||'',/text\/html/);
      assert.equal(response.headers.get('x-frame-options'),'SAMEORIGIN');
      const body=await response.text();
      if(method==='HEAD')assert.equal(body,'');
      else{assert.match(body,/webglMapInit/);assert.match(body,/deploymentCheck/);assert.match(body,/domain=https%3A%2F%2Fculture\.test/);}
      assert.ok(!body.includes(env.KOPIS_API_KEY));assert.ok(!body.includes(env.DATABASE_URL));
    }
    assert.equal((await handleCloudRequest(request(query,'POST',pathname),{env,repository})).status,405);
  }
  assert.equal(databaseCalls,0);
});

test('cloud routing normalization never permits mismatched, duplicate or arbitrary frame parameters',async()=>{
  const repository={withStore:async()=>{throw new Error('Maps must not access the database');}};
  const env={VWORLD_API_KEY:key};
  const invalid:URLSearchParams[]=[];
  for(const value of ['','other','/api/maps/vworld/frame','maps/vworld/frame/','maps,vworld,frame']){
    const query=params();query.set('path',value);invalid.push(query);
  }
  const duplicate=params();duplicate.append('path','maps/vworld/frame');duplicate.append('path','maps/vworld/frame');invalid.push(duplicate);
  const unknown=params();unknown.set('path','maps/vworld/frame');unknown.set('unexpected','value');invalid.push(unknown);
  const duplicateInput=params();duplicateInput.set('path','maps/vworld/frame');duplicateInput.append('lat','38');invalid.push(duplicateInput);
  for(const query of invalid)for(const method of ['GET','HEAD']){
    const response=await handleCloudRequest(request(query,method),{env,repository});
    assert.equal(response.status,400,query.toString());
    const body=await response.text();assert.ok(!body.includes(key));if(method==='HEAD')assert.equal(body,'');
  }
  assert.equal((await handleCloudRequest(request(params()),{env,repository})).status,200);
  const capture=params();capture.set('path','maps/vworld/frame');
  assert.equal((await handleCloudRequest(request(capture),{env:{},repository})).status,503,'missing keys still show setup message');
});
