import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { handleVWorldRequest } from '../server/vworld.js';
import { readConfig, type Config } from '../server/config.js';
import { createApp, isSearchRoute } from '../server/app.js';
import { handleCloudRequest } from '../server/cloud/handler.js';
import { Store } from '../server/store.js';
import { DEFAULT_CITIES } from '../server/providers/cities.js';

const key='TEST_BROWSER_VWORLD_KEY';
const query=new URLSearchParams({lat:'37.5665',lon:'126.978',label:'TEST 공연장',channel:'TestChannel123'});
const route='/api/maps/vworld/frame';
const request=(pathname=route,params=query,method='GET')=>new Request(`https://culture.test${pathname}?${params}`,{method});
async function html(label='TEST 공연장') {
  const params=new URLSearchParams(query);params.set('label',label);
  return handleVWorldRequest(request(route,params),{apiKey:key})!.text();
}

test('VWorld configuration exposes availability only and reads the dedicated optional environment value',async()=>{
  const missing=path.join(os.tmpdir(),`culture-no-env-${randomUUID()}`);
  const config=readConfig(missing,{VWORLD_API_KEY:`  ${key}  `,KOPIS_API_KEY:'TEST_PRIVATE_KOPIS',CULTURE_API_KEY:'TEST_PRIVATE_CULTURE'});
  assert.equal(config.vworld!.apiKey,key);
  const publicConfig=handleVWorldRequest(request('/api/maps/vworld/config'),config.vworld)!;
  assert.deepEqual(await publicConfig.json(),{available:true});
  assert.deepEqual(await handleVWorldRequest(request('/api/maps/vworld/config'))!.json(),{available:false});
  assert.equal(handleVWorldRequest(request('/api/other')),undefined);
  assert.equal(readConfig(missing,{}).vworld!.apiKey,'');
});

test('a missing VWorld key returns a static setup message without loading any SDK',async()=>{
  const response=handleVWorldRequest(request())!;assert.equal(response.status,503);
  const body=await response.text();assert.match(body,/연결 설정이 필요/);assert.match(body,/VWORLD_API_KEY/);
  assert.doesNotMatch(body,/<script|map\.vworld\.kr|webglMapInit/i);
  assert.equal(response.headers.get('x-frame-options'),'SAMEORIGIN');
  assert.equal(response.headers.get('content-security-policy'),"frame-ancestors 'self'");
});

test('VWorld coordinates, labels and message channels are strict and reject duplicate or unknown input',async()=>{
  const invalid:Array<Record<string,string>>=[{lat:''},{lat:'NaN'},{lat:'Infinity'},{lat:'1e2'},{lat:' 37'},{lat:'32.999'},{lat:'39.001'},
    {lon:'123.999'},{lon:'132.001'},{lon:'0x7f'},{label:'x'.repeat(121)},{label:'TEST\nvenue'},{channel:''},{channel:'a-b'},
    {channel:'x'.repeat(81)},{channel:'</script>'},{unexpected:'value'}];
  for(const changes of invalid){const params=new URLSearchParams(query);for(const [name,value]of Object.entries(changes))params.set(name,value);
    const response=handleVWorldRequest(request(route,params),{apiKey:key})!;assert.equal(response.status,400,JSON.stringify(changes));assert.ok(!(await response.text()).includes(key));}
  const duplicate=new URLSearchParams(query);duplicate.append('lat','38');assert.equal(handleVWorldRequest(request(route,duplicate),{apiKey:key})!.status,400);
  for(const [lat,lon]of [['33','124'],['39','132']]){const params=new URLSearchParams(query);params.set('lat',lat);params.set('lon',lon);assert.equal(handleVWorldRequest(request(route,params),{apiKey:key})!.status,200);}
});

test('the VWorld frame escapes HTML/script input and embeds only its browser key in the official SDK URL',async()=>{
  const malicious='</script><script>globalThis.TEST_XSS=1</script><!-- & " \u2028';
  const body=await html(malicious);assert.ok(!body.includes(malicious));assert.match(body,/\\u003c\/script\\u003e/);
  assert.equal((body.match(new RegExp(key,'g'))||[]).length,1);
  assert.match(body,/https:\/\/map\.vworld\.kr\/js\/webglMapInit\.js\.do\?version=3\.0&amp;apiKey=TEST_BROWSER_VWORLD_KEY/);
  assert.match(body,/&amp;domain=https%3A%2F%2Fculture\.test/);
  assert.doesNotMatch(body,/window\.viewer|parent\.Cesium|top\.Cesium/);
  assert.match(body,/ws3d\.viewer/);assert.match(body,/facility_build/);
  const specialKey='TEST"&<PRIVATE>';
  const special=await handleVWorldRequest(request(),{apiKey:specialKey})!.text();assert.ok(!special.includes(specialKey));assert.ok(special.includes(encodeURIComponent(specialKey)));
  const mock=executeFrame(body);assert.equal(mock.context.TEST_XSS,undefined);assert.equal(mock.elements.caption.textContent,malicious+' · 공연장 위치');
});

test('VWorld GET and HEAD work locally, reject writes, and reload a newly configured key',async t=>{
  const store=new Store(':memory:',DEFAULT_CITIES);
  const config:Config={port:4317,databasePath:':memory:',keys:{kopis:'TEST_PRIVATE_KOPIS',culture:'TEST_PRIVATE_CULTURE'},requestIntervalMs:350,syncIntervalHours:24};
  const {app}=await createApp(config,{store,providers:{},startWorker:false,serveStatic:false,searchOnly:true,allowLocalManagement:true,
    configLoader:()=>({...config,vworld:{apiKey:key}})});
  t.after(async()=>{await app.close();store.close();});
  assert.deepEqual((await app.inject('/api/maps/vworld/config')).json(),{available:false});
  assert.equal((await app.inject(`${route}?${query}`)).statusCode,503);
  assert.equal((await app.inject({url:'/api/config/reload',method:'POST',headers:{'content-type':'application/json','x-culture-request':'1'},payload:{}})).statusCode,200);
  assert.deepEqual((await app.inject('/api/maps/vworld/config')).json(),{available:true});
  for(const pathname of ['/api/maps/vworld/config',`${route}?${query}`]){
    const response=await app.inject(pathname);assert.equal(response.statusCode,200);
    assert.ok(!response.body.includes('TEST_PRIVATE_KOPIS'));assert.ok(!response.body.includes('TEST_PRIVATE_CULTURE'));
    const head=await app.inject({url:pathname,method:'HEAD'});assert.equal(head.statusCode,200);assert.equal(head.body,'');
    assert.equal((await app.inject({url:pathname,method:'POST'})).statusCode,405);
  }
  const response=await app.inject(`${route}?${query}`);assert.equal(response.headers['x-frame-options'],'SAMEORIGIN');
  const localOrigin=await app.inject({url:`${route}?${query}`,headers:{host:'localhost:4317'}});assert.match(localOrigin.body,/domain=http%3A%2F%2Flocalhost%3A4317/);
  assert.equal(isSearchRoute('GET',route),true);assert.equal(isSearchRoute('HEAD',route),true);assert.equal(isSearchRoute('POST',route),false);
});

test('all cloud VWorld outcomes bypass the database and never disclose collection/database credentials',async()=>{
  let databaseCalls=0;
  const repository={withStore:async()=>{databaseCalls++;throw new Error('TEST database must not be used');}};
  const env={VWORLD_API_KEY:key,KOPIS_API_KEY:'TEST_PRIVATE_KOPIS',CULTURE_API_KEY:'TEST_PRIVATE_CULTURE',DATABASE_URL:'TEST_PRIVATE_DATABASE',CRON_SECRET:'TEST_PRIVATE_CRON'};
  for(const pathname of ['/api/maps/vworld/config',route])for(const method of ['GET','HEAD','POST','DELETE']){
    const response=await handleCloudRequest(request(pathname,query,method),{env,repository});
    assert.equal(response.status,['GET','HEAD'].includes(method)?200:405);const body=await response.text();
    if(method==='HEAD')assert.equal(body,'');
    for(const privateValue of [env.KOPIS_API_KEY,env.CULTURE_API_KEY,env.DATABASE_URL,env.CRON_SECRET])assert.ok(!body.includes(privateValue));
    if(pathname.endsWith('/config'))assert.ok(!body.includes(key));
  }
  assert.equal((await handleCloudRequest(request(),{env:{},repository})).status,503);
  assert.equal((await handleCloudRequest(request(route,new URLSearchParams()),{env,repository})).status,400);
  assert.equal(databaseCalls,0);
});

function executeFrame(body:string,options:{sdk?:boolean;callback?:boolean;autoFlush?:boolean;sdkInitialFlight?:boolean;terrain?:{cached?:number;sample?:()=>unknown}}={}) {
  const messages:any[]=[],listeners:Record<string,Function>={},timers=new Map<number,Function>(),timerDelays=new Map<number,number>();
  const elements={state:{textContent:'loading',hidden:false},caption:{textContent:''}};
  let buildings=0,destroyed=0,removed=0,viewCount=0,timerId=0,cancelledFlights=0,flightPending=false,marker:any,view:any,renderFailure:Function|undefined;
  const viewer={entities:{add:(value:any)=>{marker=value;return value;}},camera:{viewBoundingSphere:(...args:any[])=>{view=args;viewCount++;},lookAtTransform:()=>{},cancelFlight:()=>{cancelledFlights++;flightPending=false;}},
    ...(options.terrain?{terrainProvider:{testProvider:true}}:{}),
    scene:{...(options.terrain?{globe:{getHeight:()=>options.terrain!.cached}}:{}),renderError:{addEventListener:(callback:Function)=>{renderFailure=callback;return ()=>{removed++;};}}},isDestroyed:()=>destroyed>0,destroy:()=>{destroyed++;}};
  const context:any={parent:{postMessage:(message:any,origin:string)=>messages.push({message:JSON.parse(JSON.stringify(message)),origin})},location:{origin:'https://culture.test'},
    document:{getElementById:(id:string)=>(elements as any)[id]},HTMLScriptElement:class{},
    setTimeout:(callback:Function,delay:number)=>{const id=++timerId;timers.set(id,callback);timerDelays.set(id,delay);return id;},clearTimeout:(id:number)=>{timers.delete(id);timerDelays.delete(id);},addEventListener:(name:string,callback:Function)=>{listeners[name]=callback;}};
  context.window=context;
  const Constructor=class{constructor(...args:any[]){Object.assign(this,{args});}};
  if(options.sdk!==false){
    context.ws3d={viewer};context.Cesium={Cartesian3:{fromDegrees:(...args:any[])=>args},Color:{WHITE:'white',fromCssColorString:(value:string)=>value},HeightReference:{CLAMP_TO_GROUND:'ground'},
      HeadingPitchRange:Constructor,BoundingSphere:Constructor,Matrix4:{IDENTITY:'identity'},Math:{toRadians:(value:number)=>value*Math.PI/180}};
    if(options.terrain){context.Cesium.Cartographic={fromDegrees:(longitude:number,latitude:number)=>({longitude,latitude})};if(options.terrain.sample)context.Cesium.sampleTerrainMostDetailed=options.terrain.sample;}
    context.vw={CameraPosition:Constructor,CoordZ:Constructor,Direction:Constructor,Map:class{
      setOption(){}setMapId(){}setInitPosition(){}getLayerElement(name:string){assert.equal(name,'facility_build');return {show:()=>{buildings++;}};}
      start(){if(options.callback!==false)context.vw.ws3dInitCallBack();if(options.sdkInitialFlight)flightPending=true;}
    }};
  }
  vm.createContext(context);
  for(const match of body.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(match[1])vm.runInContext(match[1],context);
  const flushFocus=()=>{const entry=[...timerDelays].find(([,value])=>value===0);if(entry){const callback=timers.get(entry[0])!;timers.delete(entry[0]);timerDelays.delete(entry[0]);callback();}};
  if(options.autoFlush!==false)flushFocus();
  return {context,elements,messages,listeners,timers,flushFocus,renderFailure:()=>renderFailure?.(),fireTimer:(delay:number)=>{const entry=[...timerDelays].find(([,value])=>value===delay);assert.ok(entry);const callback=timers.get(entry[0])!;timers.delete(entry[0]);timerDelays.delete(entry[0]);callback();if(options.autoFlush!==false)flushFocus();},finishSdkFlight:()=>{if(flightPending){view='SDK overview';flightPending=false;}},get flightPending(){return flightPending;},get cancelledFlights(){return cancelledFlights;},get buildings(){return buildings;},get destroyed(){return destroyed;},get removed(){return removed;},get marker(){return marker;},get view(){return view;},get viewCount(){return viewCount;}};
}

test('mocked official SDK displays the building layer, marks and centres the venue, then sends same-origin readiness and cleans up',async()=>{
  const mock=executeFrame(await html());assert.equal(mock.buildings,1);assert.equal(mock.marker.point.heightReference,'ground');
  assert.deepEqual(Array.from(mock.marker.position),[126.978,37.5665]);assert.equal(mock.view[0].args[0][0],126.978);
  assert.equal(mock.elements.state.hidden,true);assert.equal(mock.timers.size,0);
  assert.equal(mock.messages.length,1);assert.deepEqual(mock.messages[0],{origin:'https://culture.test',message:{type:'culture-vworld',channel:'TestChannel123',status:'ready',message:'VWorld 3D 지도에 연결했습니다. 건물 표시는 제공 지역에 따라 다릅니다.'}});
  mock.listeners.pagehide();assert.equal(mock.destroyed,1);assert.equal(mock.removed,1);mock.renderFailure();assert.equal(mock.messages.length,1);
});

test('missing SDK, timeout and render failures report safe errors; a late callback never reports ready after timeout',async()=>{
  const body=await html();const missing=executeFrame(body,{sdk:false});assert.equal(missing.messages[0].message.status,'error');assert.equal(missing.elements.state.hidden,false);
  const timed=executeFrame(body,{callback:false});assert.equal(timed.messages.length,0);Array.from(timed.timers.values())[0]();
  timed.context.vw.ws3dInitCallBack();assert.equal(timed.messages.length,1);assert.equal(timed.messages[0].message.status,'error');assert.equal(timed.buildings,0);
  const rendered=executeFrame(body);rendered.renderFailure();assert.deepEqual(rendered.messages.map(value=>value.message.status),['ready','error']);
  for(const result of [missing,timed,rendered])assert.ok(!JSON.stringify(result.messages).includes(key));
});

test('camera targets cached terrain elevation before readiness and does not sample or initialise twice',async()=>{
  let samples=0;
  const mock=executeFrame(await html(),{terrain:{cached:725,sample:()=>{samples++;throw new Error('Must use cached terrain');}}});
  assert.equal(mock.view[0].args[0][2],725);assert.equal(mock.view[1].args[2],900);
  assert.equal(mock.messages[0].message.status,'ready');assert.equal(samples,0);
  mock.context.vw.ws3dInitCallBack();assert.equal(mock.viewCount,1);assert.equal(mock.buildings,1);
});

test('terrain sampling delays first framing and readiness until the actual elevation is available',async()=>{
  let resolve!:(value:unknown)=>void;
  const result=new Promise(value=>{resolve=value;});
  const mock=executeFrame(await html(),{terrain:{sample:()=>result}});
  assert.equal(mock.viewCount,0);assert.equal(mock.messages.length,0);assert.equal(mock.elements.state.hidden,false);
  resolve([{height:1100}]);await new Promise(setImmediate);mock.flushFocus();
  assert.equal(mock.view[0].args[0][2],1100);assert.equal(mock.view[1].args[2],900);
  assert.equal(mock.messages[0].message.status,'ready');assert.equal(mock.timers.size,0);
});

test('terrain timeout opens a wider view and late success never jumps the camera after interaction is enabled',async()=>{
  let resolve!:(value:unknown)=>void;
  const result=new Promise(value=>{resolve=value;});
  const mock=executeFrame(await html(),{terrain:{sample:()=>result}});
  mock.fireTimer(3000);
  assert.equal(mock.view[1].args[2],3200);assert.equal(mock.viewCount,1);assert.equal(mock.messages.length,1);
  resolve([{height:1500}]);await new Promise(setImmediate);
  assert.equal(mock.viewCount,1);assert.equal(mock.messages.length,1);assert.equal(mock.timers.size,0);
});

test('missing terrain APIs, rejected requests and invalid heights preserve usable map readiness',async()=>{
  const body=await html();
  const absent=executeFrame(body);assert.equal(absent.view[1].args[2],3200);
  for(const sample of [()=>Promise.reject(new Error('Unavailable')),()=>{throw new Error('Unsupported');},()=>Promise.resolve([{height:NaN}]),()=>Promise.resolve([{height:100000}])]){
    const mock=executeFrame(body,{terrain:{sample}});await new Promise(setImmediate);mock.flushFocus();
    assert.equal(mock.view[1].args[2],3200);assert.equal(mock.messages[0].message.status,'ready');assert.equal(mock.timers.size,0);
  }
});

test('closing or failing the frame during terrain sampling discards pending camera work',async()=>{
  for(const action of ['close','error'] as const){
    let resolve!:(value:unknown)=>void;
    const result=new Promise(value=>{resolve=value;});
    const mock=executeFrame(await html(),{terrain:{sample:()=>result}});
    if(action==='close')mock.listeners.pagehide();else mock.renderFailure();
    resolve([{height:1300}]);await new Promise(setImmediate);
    assert.equal(mock.viewCount,0);assert.equal(mock.messages.some(value=>value.message.status==='ready'),false);
    assert.equal(mock.timers.size,0);
    if(action==='close'){assert.equal(mock.destroyed,1);assert.equal(mock.removed,1);}
  }
});

test('the SDK initial flight starts after its callback and is cancelled before the deferred venue framing becomes ready',async()=>{
  const mock=executeFrame(await html(),{autoFlush:false,sdkInitialFlight:true,terrain:{cached:170}});
  assert.equal(mock.flightPending,true);assert.equal(mock.viewCount,0);assert.equal(mock.messages.length,0);assert.equal(mock.elements.state.hidden,false);
  mock.flushFocus();assert.equal(mock.cancelledFlights,1);assert.equal(mock.flightPending,false);
  assert.equal(mock.view[0].args[0][2],170);assert.equal(mock.view[1].args[2],900);assert.equal(mock.messages[0].message.status,'ready');
  mock.finishSdkFlight();assert.notEqual(mock.view,'SDK overview');assert.equal(mock.viewCount,1);
});

test('closing or failing between SDK callback and deferred focus never moves the camera or reports readiness',async()=>{
  for(const action of ['close','error']){
    const mock=executeFrame(await html(),{autoFlush:false,sdkInitialFlight:true,terrain:{cached:170}});
    if(action==='close')mock.listeners.pagehide();else mock.renderFailure();
    mock.flushFocus();assert.equal(mock.viewCount,0);assert.equal(mock.cancelledFlights,0);assert.equal(mock.messages.some(value=>value.message.status==='ready'),false);
  }
});
