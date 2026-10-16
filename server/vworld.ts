/** VWorld's browser SDK runs in its own document; no application/provider credentials enter it. */
export interface VWorldConfig { apiKey:string }
interface FrameInput {lat:number;lon:number;label:string;channel:string}
const ROUTES=['/api/maps/vworld/config','/api/maps/vworld/frame'];
const baseHeaders={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'};
const frameHeaders={...baseHeaders,'Content-Type':'text/html; charset=utf-8','X-Frame-Options':'SAMEORIGIN','Content-Security-Policy':"frame-ancestors 'self'"};
export function isVWorldRoute(pathname:string):boolean {return ROUTES.includes(pathname.replace(/\/$/,''));}
function json(body:unknown,status:number,head:boolean,extra:Record<string,string>={}) {
  return new Response(head?null:JSON.stringify(body),{status,headers:{...baseHeaders,'Content-Type':'application/json; charset=utf-8',...extra}});
}
function parseInput(query:URLSearchParams):FrameInput|undefined {
  const allowed=new Set(['lat','lon','label','channel']);
  for(const key of query.keys())if(!allowed.has(key)||query.getAll(key).length!==1)return;
  const latitude=query.get('lat')||'',longitude=query.get('lon')||'';
  const numeric=/^\d{1,3}(?:\.\d{1,15})?$/;
  if(!numeric.test(latitude)||!numeric.test(longitude))return;
  const lat=Number(latitude),lon=Number(longitude);
  const label=query.get('label')??'공연장',channel=query.get('channel')||'';
  if(lat<33||lat>39||lon<124||lon>132||label.length>120||/[\u0000-\u001f\u007f]/.test(label)||!/^[A-Za-z0-9]{1,80}$/.test(channel))return;
  return {lat,lon,label,channel};
}
// JSON in script text must not contain a literal closing tag, HTML comment or JS line separator.
function scriptJson(value:unknown):string {
  return JSON.stringify(value).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
}
function attribute(value:string):string {return value.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function frame(input:FrameInput,apiKey:string,origin:string):string {
  // The official HTTPS integration guide requires the registered domain parameter.
  const sdk=`https://map.vworld.kr/js/webglMapInit.js.do?version=3.0&apiKey=${encodeURIComponent(apiKey)}&domain=${encodeURIComponent(origin)}`;
  // SDK 3.0 initialization follows V-world's official 2026 training example.
  // https://github.com/V-world/V-world_API_sample/tree/master/브이월드_교육/2026년_브이월드_교육
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>공연장 주변 VWorld 3D 지도</title>
<style>html,body,#vmap{width:100%;height:100%;margin:0;overflow:hidden;background:#0b1727}body{font:14px/1.5 system-ui,sans-serif;color:#e8f1f5}#state{position:absolute;inset:0;z-index:100;background:#0b1727e8;display:grid;place-items:center;padding:24px;text-align:center;box-sizing:border-box}#caption{position:absolute;left:12px;bottom:38px;z-index:20;max-width:calc(100% - 48px);padding:8px 12px;border-radius:8px;background:#0b1727d9;pointer-events:none;overflow-wrap:anywhere}#state[hidden]{display:none}</style>
<script>(function(){
  'use strict';const input=${scriptJson(input)};let disposed=false,failed=false,ready=false,timer,cleanup;
  function notify(status,message){if(!disposed)parent.postMessage({type:'culture-vworld',channel:input.channel,status:status,message:message},location.origin);}
  function display(message){const element=document.getElementById('state');if(element){element.textContent=message;element.hidden=false;}}
  function fail(){if(disposed)return;const message='VWorld 3D 지도를 불러오지 못했습니다. 지도 인증키의 사용 URL과 네트워크 연결을 확인하세요.';display(message);if(failed)return;failed=true;clearTimeout(timer);notify('error',message);}
  window.cultureVWorld={input:input,fail:fail,isStopped:function(){return disposed||failed;},onDispose:function(callback){cleanup=callback;},ready:function(){if(disposed||failed||ready)return;ready=true;clearTimeout(timer);const element=document.getElementById('state');if(element)element.hidden=true;notify('ready','VWorld 3D 지도에 연결했습니다. 건물 표시는 제공 지역에 따라 다릅니다.');}};
  timer=setTimeout(fail,25000);
  window.addEventListener('error',function(event){if(!ready||event.target instanceof HTMLScriptElement)fail();},true);
  window.addEventListener('pagehide',function(){disposed=true;clearTimeout(timer);try{if(cleanup)cleanup();}catch(_error){}},{once:true});
})();</script>
<script src="${attribute(sdk)}" onerror="window.cultureVWorld.fail()"></script></head><body>
<div id="vmap" aria-label="VWorld 3D 지도"></div><div id="state" role="status">VWorld 3D 지도를 불러오는 중입니다.</div><div id="caption"></div>
<script>(function(){
  'use strict';const state=window.cultureVWorld,input=state.input;document.getElementById('caption').textContent=input.label+' · 공연장 위치';
  if(state.isStopped()){state.fail();return;}
  try{
    if(!window.vw||typeof vw.Map!=='function')throw new Error('SDK unavailable');
    const position=new vw.CameraPosition(new vw.CoordZ(input.lon,input.lat,2600),new vw.Direction(0,-60,0));
    const map=new vw.Map();map.setOption({mapId:'vmap',initPosition:position,logo:true,navigation:true});map.setMapId('vmap');map.setInitPosition(position);
    let initialized=false;
    vw.ws3dInitCallBack=function(){
      if(state.isStopped()||initialized)return;initialized=true;
      try{
        if(!window.ws3d||!window.ws3d.viewer||!window.Cesium)throw new Error('Viewer unavailable');
        const viewer=window.ws3d.viewer;
        let removeRenderError,terrainTimer,focusTimer,terrainSettled=false;
        state.onDispose(function(){terrainSettled=true;clearTimeout(terrainTimer);clearTimeout(focusTimer);if(typeof removeRenderError==='function')removeRenderError();if(typeof viewer.destroy==='function'&&(!viewer.isDestroyed||!viewer.isDestroyed()))viewer.destroy();});
        function showBuildings(id){try{const layer=map.getLayerElement(id);if(layer&&typeof layer.show==='function'){layer.show();return true;}}catch(_error){}return false;}
        // Current SDK provides LoD1–4 together; older SDKs retain the LoD4 layer.
        if(!showBuildings('facility_build_all')&&!showBuildings('facility_build'))throw new Error('Building layer unavailable');
        const target=Cesium.Cartesian3.fromDegrees(input.lon,input.lat);
        viewer.entities.add({name:'공연장 위치',position:target,
          point:{pixelSize:12,color:Cesium.Color.fromCssColorString('#ffbd9b'),outlineColor:Cesium.Color.WHITE,outlineWidth:2,heightReference:Cesium.HeightReference.CLAMP_TO_GROUND,disableDepthTestDistance:Number.POSITIVE_INFINITY}});
        if(viewer.scene&&viewer.scene.renderError)removeRenderError=viewer.scene.renderError.addEventListener(state.fail);
        function validHeight(value){return typeof value==='number'&&Number.isFinite(value)&&value>=-500&&value<=9000;}
        let cartographic;
        try{if(Cesium.Cartographic&&typeof Cesium.Cartographic.fromDegrees==='function')cartographic=Cesium.Cartographic.fromDegrees(input.lon,input.lat);}catch(_error){}
        function cachedHeight(){
          try{const globe=viewer.scene&&viewer.scene.globe;const height=cartographic&&globe&&typeof globe.getHeight==='function'?globe.getHeight(cartographic):undefined;return validHeight(height)?height:undefined;}catch(_error){return undefined;}
        }
        // Frame once, before enabling interaction. Late terrain results never move an active camera.
        function focus(height){
          if(terrainSettled)return;terrainSettled=true;clearTimeout(terrainTimer);
          if(state.isStopped()||(typeof viewer.isDestroyed==='function'&&viewer.isDestroyed()))return;
          // SDK 3.0 starts its initial flyTo immediately AFTER ws3dInitCallBack returns.
          // Let that call finish, cancel its flight, then frame once before exposing interaction.
          focusTimer=setTimeout(function(){
            if(state.isStopped()||(typeof viewer.isDestroyed==='function'&&viewer.isDestroyed()))return;
            try{
              if(typeof viewer.camera.cancelFlight==='function')viewer.camera.cancelFlight();
              const known=validHeight(height),centre=Cesium.Cartesian3.fromDegrees(input.lon,input.lat,known?height:0);
              // Unsupported/missing terrain keeps a wider overview instead of aiming close below hills.
              viewer.camera.viewBoundingSphere(new Cesium.BoundingSphere(centre,100),new Cesium.HeadingPitchRange(0,Cesium.Math.toRadians(-50),known?900:3200));
              viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);state.ready();
            }catch(_error){state.fail();}
          },0);
        }
        const cached=cachedHeight();
        if(validHeight(cached)){focus(cached);return;}
        if(!cartographic||!viewer.terrainProvider||typeof Cesium.sampleTerrainMostDetailed!=='function'){focus(undefined);return;}
        terrainTimer=setTimeout(function(){focus(cachedHeight());},3000);
        try{
          Promise.resolve(Cesium.sampleTerrainMostDetailed(viewer.terrainProvider,[cartographic])).then(function(positions){
            const height=positions&&positions[0]&&positions[0].height;focus(validHeight(height)?height:cachedHeight());
          },function(){focus(cachedHeight());});
        }catch(_error){focus(cachedHeight());}
      }catch(_error){state.fail();}
    };
    map.start();
  }catch(_error){state.fail();}
})();</script></body></html>`;
}
/** Both local Fastify and the cloud wrapper call this before any database-dependent work. */
export function handleVWorldRequest(request:Request,config?:VWorldConfig):Response|undefined {
  const url=new URL(request.url);if(!isVWorldRoute(url.pathname))return;
  const method=request.method.toUpperCase(),head=method==='HEAD';
  if(!['GET','HEAD'].includes(method))return json({error:'조회 요청만 허용됩니다.'},405,false,{Allow:'GET, HEAD'});
  const key=config?.apiKey.trim()||'';
  if(url.pathname.replace(/\/$/,'').endsWith('/config'))return json({available:!!key},200,head);
  const input=parseInput(url.searchParams);
  if(!input)return json({error:'지도 좌표와 공연장 이름, 연결 식별자를 확인하세요.'},400,head);
  if(!key)return new Response(head?null:'<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VWorld 연결 설정 필요</title><body style="margin:0;padding:32px;background:#0b1727;color:#e8f1f5;font:16px/1.6 system-ui,sans-serif"><p>VWorld 3D 지도 연결 설정이 필요합니다.</p><p>VWorld 인증키를 발급받아 서버의 VWORLD_API_KEY에 입력하세요.</p></body></html>',{status:503,headers:frameHeaders});
  return new Response(head?null:frame(input,key,url.origin),{status:200,headers:frameHeaders});
}
